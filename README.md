## Aurora APR API

This Docker container contains an API endpoint for data such as APRs, prices, etc. related to the WETH-NEAR-LP staking pool on Aurora Swap.
Most of the core functions are based on https://vfat.tools/aurora/auroraswap/. Extending this API with more pools should therefore be relatively easy.


## Development

Locally:

`yarn dev`

or with Docker:

```
yarn docker:build-dev
yarn docker:dev
```

Testing:

`yarn test`


## Production (Docker Container)

Build:

`yarn docker:build`
or
`docker build -t aurora-apr-api .`

Run:

`yarn docker:run`
or
`docker run -d -p 8080:8080 --env PORT=8080 aurora-apr-api`

Deployment on Heroku:

```
heroku container:login
heroku create YOUR_APP_NAME
heroku container:push web -a YOUR_APP_NAME
heroku container:release web
heroku open -a YOUR_APP_NAME
```
