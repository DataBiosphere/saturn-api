const cors = require('cors')
const express = require('express')
const fs = require('fs')
const {google} = require('googleapis')
const https = require('https')
const {URL} = require('url')
const iam = google.iam('v1')
const storage = google.storage('v1')

const app = express()
const circleHostname = 'circleci.com'
const circleRootPath = '/api/v1.1'

const config = JSON.parse(fs.readFileSync('config.json'))

const {circleApiToken} = config

app.use(cors())

function formatObj(obj) {
  return JSON.stringify(obj, null, 2)+'\n'
}

async function withAppEngineDefaultSaKey(f) {
  // TODO(dmohs): Which scope is actually required?
  const scopes = ['https://www.googleapis.com/auth/cloud-platform']
  const client = (await google.auth.getClient()).createScoped(scopes)
  const projectId = await google.auth.getDefaultProjectId()

  iam.projects.serviceAccounts.keys.create({
    auth: client,
    name: `projects/-/serviceAccounts/${projectId}@appspot.gserviceaccount.com`
  }, (err, saRes)=> {
    if (err) throw err
    appEngineDefaultSaKey = Buffer.from(saRes.data.privateKeyData, 'base64').toString()
    Promise.resolve(f(appEngineDefaultSaKey)).then(() => {
      iam.projects.serviceAccounts.keys.delete({auth: client, name: saRes.data.name})
    })
  })
}

function httpsRequest(options) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      options,
      (res) => {
        let body = ''
        res.on('data', (chunk) => body+=chunk)
        res.on('end', () => {
          res.body = body
          resolve(res)
        })
      }
    )
    if (options.body) {
      req.write(options.body)
    }
    req.end()
  })
}

function circleRequest(options) {
  options.hostname = circleHostname
  options.path = circleRootPath+options.path+`?circle-token=${circleApiToken}`
  options.headers = options.headers || {}
  options.headers['Accept'] = '*/*'
  return httpsRequest(options)
}

async function findBuild(buildNumber, remainingAttempts) {
  if (remainingAttempts > 0) {
    const buildRes = await circleRequest({
      path: `/project/github/DataBiosphere/saturn-ui/${buildNumber}`
    })
    const build = JSON.parse(buildRes.body)
    if (build.workflows.job_name !== 'build') {
      return findBuild(build.previous_successful_build.build_num, remainingAttempts - 1)
    } else {
      return build
    }
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(() => { resolve() }, milliseconds)
  })
}

function waitForOutcome(buildNumber, waitMilliseconds, remainingAttempts) {
  if (remainingAttempts > 0) {
    return new Promise(async (resolve, reject) => {
      const res = await circleRequest({
        path: `/project/github/DataBiosphere/saturn-ui/${buildNumber}`
      })
      const build = JSON.parse(res.body)
      if (build.outcome) {
        resolve(build)
      } else {
        await delay(waitMilliseconds)
        resolve(await waitForOutcome(buildNumber, waitMilliseconds, remainingAttempts - 1))
      }
    })
  }
}

async function findLastSuccessfulDevBuild(repoUrl) {
  const projectsRes = await circleRequest({path: '/projects'})
  const project = JSON.parse(projectsRes.body).filter((x) => x.vcs_url === repoUrl)[0]
  return await findBuild(project.branches.dev.last_success.build_num, 3)
}

async function getFirstArtifactsUrl(build) {
  const artifactsRes = await circleRequest({
    path: `/project/github/DataBiosphere/saturn-ui/${build.build_num}/artifacts`
  })
  const artifacts = JSON.parse(artifactsRes.body)
  if (artifacts.length === 0) throw "No artifacts found"
  return artifacts[0].url
}

async function getProdConfigJson() {
  return new Promise(async (resolve, reject) => {
    // TODO(dmohs): Which scope is actually required?
    const scopes = ['https://www.googleapis.com/auth/cloud-platform']
    const client = (await google.auth.getClient()).createScoped(scopes)
    storage.objects.get({
      auth: client,
      bucket: 'bvdp-saturn-prod-config',
      object: 'config.json?alt=media'
    }, async (err, objRes) => {
      if (err) throw err
      resolve(objRes.data)
    })
  })
}

async function deployProd(project, includeConfigJson, res) {
  const repoUrl = `https://github.com/DataBiosphere/${project}`
  const build = await findLastSuccessfulDevBuild(repoUrl)
  const artifactUrl = await getFirstArtifactsUrl(build)
  let configJson = undefined;
  if (includeConfigJson) {
    configJson = await getProdConfigJson()
  }
  withAppEngineDefaultSaKey(async (key) => {
    const circleRes = await circleRequest({
      path: `/project/github/DataBiosphere/${project}/tree/dev`,
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: formatObj({
        build_parameters: {
          CIRCLE_JOB: 'deploy-prod',
          ARTIFACT_URL: artifactUrl,
          CONFIG_JSON: configJson,
          SA_KEY_JSON: key
        }
      })
    })
    if (circleRes.statusCode < 200 || circleRes.statusCode > 299) {
      res.status(circleRes.statusCode).end(formatObj({
        error: {
          message: `Circle returned status code ${circleRes.statusCode}.`,
          circleResponse: circleRes.body
        }
      }))
    } else {
      const newBuildNum = JSON.parse(circleRes.body).build_num
      const build = await waitForOutcome(newBuildNum, 2000, 30)
      if (build) {
        res.status(204).end()
      } else {
        res.status(500).end(formatObj({
          error: {
            message: "Timeout waiting for build to complete.",
            buildNumber: newBuildNum
          }
        }))
      }
    }
  })
}

app.get('/deploy-api-prod', async (req, res) => {
  // if (!(req.get('x-appengine-cron') === 'true')) {
  //   res.status(403).end(formatObj({error: "unauthorized"}))
  //   return
  // }

  await deployProd('saturn-api', true, res)
})

app.get('/deploy-ui-prod', async (req, res) => {
  // if (!(req.get('x-appengine-cron') === 'true')) {
  //   res.status(403).end(formatObj({error: "unauthorized"}))
  //   return
  // }

  await deployProd('saturn-ui', false, res)
})

const port = 8080;
app.listen(port, () => console.log(`App listening on port ${port}.`))
