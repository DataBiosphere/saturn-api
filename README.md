# Saturn API
This project exists to manage prod deploys of [Saturn UI](https://github.com/DataBiosphere/Saturn-UI). It is an [Express](https://expressjs.com) app which runs on Google Cloud Platform in a `nodejs8` standard container.

Builds and dev deploys are handled by CircleCI, and the API itself handles prod deploys. The API is deployed to dev to ensure that it is not broken, but only does anything in prod.

### Cron

The [cron.yaml](cron.yaml) file triggers deploys. It is deployed to [here](https://console.cloud.google.com/appengine/taskqueues/cron?project=bvdp-saturn-prod&organizationId=548622027621&tab=CRON).

It is deployed manually:

```sh
gcloud app deploy cron.yaml --project=bvdp-saturn-prod
```

### Prod deploys

The cron calls the `/deploy-api-prod` endpoint daily, followed by the `/deploy-ui-prod` endpoint. To ensure that these can only be called by the cron, we check for the presence of the `x-appengine-cron` header on the request, which GCP will strip out of any external request. We also ensure that the active project is `bvdp-saturn-prod`. These endpoints promote the most recent deploy of the respective service from dev.

The other function of this app is to update a public JSON file containing the download prices in USD from Cloud Storage to "Worldwide Destinations (excluding Asia & Australia)". This happens nightly when the cron calls the `/update-download-prices` endpoint.

### Config

Prod pulls its `config.json` from [this bucket](https://console.cloud.google.com/storage/browser/bvdp-saturn-prod-config?project=bvdp-saturn-prod&organizationId=548622027621).

### Developing locally

1. Disable the logic in the `authDeployProd` function, so that calls will work.
2. Fill in the local [config.json](config.json).
3. Generate and download a json key [here](https://console.cloud.google.com/apis/credentials/serviceaccountkey?project=bvdp-saturn-prod&organizationId=548622027621) for the App Engine Default service account, and export a variable called `GOOGLE_APPLICATION_CREDENTIALS` pointing to the file.
4. `npm install`, `npm start`. The application will not load new code automatically, so you'll have to restart it.
5. `curl` the endpoint you want to test!
