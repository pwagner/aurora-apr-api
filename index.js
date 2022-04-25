'use strict';
const ethers = require('ethers');
const ethcall = require('ethcall');

const { RPC, ACTIVE_POOL_IDS } = require('./src/config');
const { getAPR } = require('./src/utils');

const API = {
  YOUR_ADDRESS: "0x000000FCd5d9446CFa4d00Fc8e454fDdDdDD3ff5", // TODO: optional API param!
  provider: new ethers.providers.JsonRpcProvider(RPC.AURORA.rpcUrls[0]),
  ethcallProvider: new ethcall.Provider()
};
API.ethcallProvider.init(API.provider);

const express = require('express'),
    app = express();

// Default pool ID gets loaded from config.
app.get('/', async (req, res) => {
    await res.json(await getAPR(API, ACTIVE_POOL_IDS));
    return;
});

// TODO: Here we could generalize and enable all pools:
// app.get('/:poolIds', async (req, res) => {
//     const poolIds = req.params.poolIds.split(',');
//     await res.json(await getAPR(API, poolIds));
//
//     return;
// });

let port = process.env.PORT || 8080;
app.listen(port, () => {
    console.log(`API endpoints ready on port ${port}`);
});

module.exports = app;
