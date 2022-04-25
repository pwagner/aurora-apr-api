const ethers = require('ethers');
const ethcall = require('ethcall');
const needle = require('needle');
const cache = require('memory-cache');

const { BRL_CHEF_ABI, CURVE_ABI, STABLESWAP_ABI, UNI_ABI, MINTER_ABI, HARVEST_VAULT_ABI, ERC20_ABI } = require('./abi');
const { CACHE_TIME_MS, BRL_CHEF_ADDR, REWARD_TOKEN_TICKER, AURORA_TOKENS } = require('./config');

/*
 * Utility functions mostly based on vfat-tool, h/t
 * https://github.com/vfat-tools/vfat-tools
 */

 async function getAPR(API, selectedPools) {
   const BRL_CHEF = new ethers.Contract(BRL_CHEF_ADDR, BRL_CHEF_ABI, API.provider);
   const blockNumber = await API.provider.getBlockNumber();
   const multiplier = await BRL_CHEF.getMultiplier(blockNumber, blockNumber + 1)
   const rewardsPerWeek = await BRL_CHEF.BRLPerBlock() / 1e18 * multiplier * 604800 / 1.1;
   const chef = await loadAuroraChefContract(
     API,
     {},
     await getAuroraPrices(),
     BRL_CHEF,
     BRL_CHEF_ADDR,
     BRL_CHEF_ABI,
     REWARD_TOKEN_TICKER,
     "BRL",
     null,
     rewardsPerWeek,
     "pendingBRL",
     selectedPools
   );

   return {
     chef: BRL_CHEF_ADDR,
     blockNumber: parseInt(blockNumber),
     // multiplier: parseFloat(multiplier),
     // rewardsPerWeek: parseFloat(rewardsPerWeek),
     ...chef
   };
 }

async function getAuroraPrices() {
    const idPrices = await lookUpPrices(AURORA_TOKENS);
    const prices = {}
    for (const bt of AURORA_TOKENS)
        if (idPrices[bt.id])
            prices[bt.contract] = idPrices[bt.id];
    return prices;
}

const chunk = (arr, n) => arr.length ? [arr.slice(0, n), ...chunk(arr.slice(n), n)] : []

const lookUpPrices = async function(tokens) {
  const id_array = tokens.map(x => x.id);
  const prices = {}
  for (const id_chunk of chunk(id_array, 50)) {
    let ids = id_chunk.join('%2C')

    try {
      const cacheKey = `coingecko_${ids}`;
      let response = cache.get(cacheKey);
      if (!response) {
        response = await needle('get', `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`);
      }
      cache.put(cacheKey, response);
      for (const [key, v] of Object.entries(response.body)) {
        if (v.usd) prices[key] =  { ...v, symbol: tokens.find(token => token.id === key).symbol };
      }
    } catch (err) {
      console.log('Could not fetch prices from coingecko', err);

      throw err;
    }
  }

  return prices
}

async function getAuroraErc20(API, token, address, stakingAddress) {
    if (address == "0x0000000000000000000000000000000000000000") {
      return {
        address,
        name : "Aurora",
        symbol : "AOA",
        totalSupply: 1e8,
        decimals: 18,
        staked: 0,
        unstaked: 0,
        contract: null,
        tokens:[address]
      }
    }
    const calls = [token.decimals(), token.balanceOf(stakingAddress), token.balanceOf(API.YOUR_ADDRESS),
      token.name(), token.symbol(), token.totalSupply()];
    const [decimals, staked, unstaked, name, symbol, totalSupply] = await API.ethcallProvider.all(calls);
    return {
        address,
        name,
        symbol,
        totalSupply,
        decimals : decimals,
        staked:  staked / 10 ** decimals,
        unstaked: unstaked  / 10 ** decimals,
        contract: token,
        tokens : [address]
    };
}

async function getAuroraToken(API, tokenAddress, stakingAddress) {
  if (tokenAddress == "0x0000000000000000000000000000000000000000") {
    return getAuroraErc20(API, null, tokenAddress, "")
  }

  // const type = window.localStorage.getItem(tokenAddress);
  // if (type) return getAuroraStoredToken(API, tokenAddress, stakingAddress, type);

  const type = cache.get(tokenAddress);
  if (type) return getAuroraStoredToken(API, tokenAddress, stakingAddress, type);

  try {
    const crv = new ethcall.Contract(tokenAddress, CURVE_ABI);
    const [minter] = await API.ethcallProvider.all([crv.minter()]);
    const res = await getAuroraCurveToken(API, crv, tokenAddress, stakingAddress, minter);
    cache.put(tokenAddress, "curve", CACHE_TIME_MS);
    return res;
  } catch(err){}

  try {
    const stable = new ethcall.Contract(tokenAddress, STABLESWAP_ABI);
    const _coin0 = await API.ethcallProvider.all([stable.coins(0)]);
    cache.put(tokenAddress, "stableswap", CACHE_TIME_MS);
    return await getAuroraStableswapToken(API, stable, tokenAddress, stakingAddress);
  } catch (err){}

  try {
    const pool = new ethcall.Contract(tokenAddress, UNI_ABI);
    const _token0 = await API.ethcallProvider.all([pool.token0()]);
    const uniPool = await getAuroraUniPool(API, pool, tokenAddress, stakingAddress);
    cache.put(tokenAddress, "uniswap", CACHE_TIME_MS);
    return uniPool;
  } catch(err){}

  try {
    const basicVault = new ethcall.Contract(tokenAddress, HARVEST_VAULT_ABI);
    const _token = await API.ethcallProvider.all([basicVault.underlying()]);
    const res = await getAuroraBasicVault(API, basicVault, tokenAddress, stakingAddress);
    cache.put(tokenAddress, "basicAuroraVault", CACHE_TIME_MS);
    return res;
  } catch(err){}

  try {
    const erc20 = new ethcall.Contract(tokenAddress, ERC20_ABI);
    const _name = await API.ethcallProvider.all([erc20.name()]);
    const erc20tok = await getAuroraErc20(API, erc20, tokenAddress, stakingAddress);
    cache.put(tokenAddress, "erc20", CACHE_TIME_MS);
    return erc20tok;
  } catch(err) {
    console.log(err);
    console.log(`Couldn't match ${tokenAddress} to any known token type.`);
  }
}

async function getAuroraPoolInfo(app, chefContract, chefAddress, poolIndex, pendingRewardsFunction) {
  const poolInfo = await chefContract.poolInfo(poolIndex);
  if (poolInfo.allocPoint == 0) {
    return {
      address: poolInfo.lpToken,
      allocPoints: poolInfo.allocPoint ? poolInfo.allocPoint : 1,
      poolToken: null,
      userStaked : 0,
      pendingRewardTokens : 0,
    };
  }
  const selectedToken = poolInfo.lpToken ? poolInfo.lpToken : (poolInfo.token ? poolInfo.token : poolInfo.stakingToken);
  const poolToken = await getAuroraToken(app, selectedToken, chefAddress);
  const userInfo = await chefContract.userInfo(poolIndex, app.YOUR_ADDRESS);
  const pendingRewardTokens = await chefContract.callStatic[pendingRewardsFunction](poolIndex, app.YOUR_ADDRESS);
  const staked = userInfo.amount / 10 ** poolToken.decimals;
  return {
      address : selectedToken,
      allocPoints: poolInfo.allocPoint ? poolInfo.allocPoint : 1,
      poolToken: poolToken,
      userStaked : staked,
      pendingRewardTokens : pendingRewardTokens / 10 ** 18,
      depositFee : (poolInfo.depositFeeBP ? poolInfo.depositFeeBP : 0) / 100,
      withdrawFee : (poolInfo.withdrawFeeBP ? poolInfo.withdrawFeeBP : 0) / 100
  };
}

async function getAuroraUniPool(API, pool, poolAddress, stakingAddress) {
  const calls = [
    pool.decimals(), pool.token0(), pool.token1(), pool.symbol(), pool.name(),
    pool.totalSupply(), pool.balanceOf(stakingAddress), pool.balanceOf(API.YOUR_ADDRESS)
  ];
  const [decimals, token0, token1, symbol, name, totalSupply, staked, unstaked]
    = await API.ethcallProvider.all(calls);
  let q0, q1, is1inch;
  try {
    const [reserves] = await API.ethcallProvider.all([pool.getReserves()]);
    q0 = reserves._reserve0;
    q1 = reserves._reserve1;
    is1inch = false;
  } catch(error) { //for 1inch
    if (token0 == "0x0000000000000000000000000000000000000000") {
      q0 = await API.provider.getBalance(poolAddress);
    }
    else {
      const c0 = new ethers.Contract(token0, ERC20_ABI, API.provider);
      q0 = await c0.balanceOf(poolAddress);
    }
    if (token1 == "0x0000000000000000000000000000000000000000") {
      q1 = await API.provider.getBalance(poolAddress);
    }
    else {
      const c1 = new ethers.Contract(token1, ERC20_ABI, API.provider);
      q1 = await c1.balanceOf(poolAddress);
    }
    is1inch = true;
  }
  return {
      symbol,
      name,
      address: poolAddress,
      token0: token0,
      q0,
      token1: token1,
      q1,
      totalSupply: totalSupply / 10 ** decimals,
      stakingAddress: stakingAddress,
      staked: staked / 10 ** decimals,
      decimals: decimals,
      unstaked: unstaked / 10 ** decimals,
      contract: pool,
      tokens : [token0, token1],
      is1inch
  };
}

async function getAuroraBasicVault(API, vault, address, stakingAddress) {
  const calls = [vault.decimals(), vault.underlying(), vault.name(), vault.symbol(),
    vault.totalSupply(), vault.balanceOf(stakingAddress), vault.balanceOf(API.YOUR_ADDRESS),
    vault.underlyingBalanceWithInvestment()];
  const [ decimals, underlying, name, symbol, totalSupply, staked, unstaked, balance] =
    await API.ethcallProvider.all(calls);
  const token = await getAuroraToken(API, underlying, address);
  return {
    address,
    name,
    symbol,
    totalSupply,
    decimals,
    staked: staked / 10 ** decimals,
    unstaked: unstaked / 10 ** decimals,
    token: token,
    balance,
    contract: vault,
    tokens : token.tokens
  }
}

async function getAuroraCurveToken(API, curve, address, stakingAddress, minterAddress) {
  const minter = new ethcall.Contract(minterAddress, MINTER_ABI)
  const [virtualPrice, coin0] = await API.ethcallProvider.all([minter.get_virtual_price(), minter.coins(0)]);
  const token = await getToken(API, coin0, address);
  const calls = [curve.decimals(), curve.balanceOf(stakingAddress), curve.balanceOf(API.YOUR_ADDRESS),
    curve.name(), curve.symbol(), curve.totalSupply()];
  const [decimals, staked, unstaked, name, symbol, totalSupply] = await API.ethcallProvider.all(calls);
  return {
      address,
      name,
      symbol,
      totalSupply,
      decimals : decimals,
      staked:  staked / 10 ** decimals,
      unstaked: unstaked  / 10 ** decimals,
      contract: curve,
      tokens : [address, coin0],
      token,
      virtualPrice : virtualPrice / 1e18
  };
}

async function getAuroraStableswapToken(API, stable, address, stakingAddress) {
  const calls = [stable.decimals(), stable.balanceOf(stakingAddress), stable.balanceOf(API.YOUR_ADDRESS),
    stable.name(), stable.symbol(), stable.totalSupply(), stable.get_virtual_price(), stable.coins(0)];
  const [decimals, staked, unstaked, name, symbol, totalSupply, virtualPrice, coin0]
    = await API.ethcallProvider.all(calls);
  const token = await getToken(API, coin0, address);
  return {
      address,
      name,
      symbol,
      totalSupply,
      decimals : decimals,
      staked:  staked / 10 ** decimals,
      unstaked: unstaked  / 10 ** decimals,
      contract: stable,
      tokens : [address, coin0],
      token,
      virtualPrice : virtualPrice / 1e18
  };
}

async function getAuroraStoredToken(API, tokenAddress, stakingAddress, type) {
  switch (type) {
    case "curve":
      const crv = new ethcall.Contract(tokenAddress, CURVE_ABI);
      const [minter] = await API.ethcallProvider.all([crv.minter()]);
      return await getAuroraCurveToken(API, crv, tokenAddress, stakingAddress, minter);
    case "stableswap":
      const stable = new ethcall.Contract(tokenAddress, STABLESWAP_ABI);
      return await getAuroraStableswapToken(API, stable, tokenAddress, stakingAddress);
    case "uniswap":
      const pool = new ethcall.Contract(tokenAddress, UNI_ABI);
      return await getAuroraUniPool(API, pool, tokenAddress, stakingAddress);
    case "basicAuroraVault":
      const basicAuroraVault = new ethcall.Contract(tokenAddress, HARVEST_VAULT_ABI);
      return await getAuroraBasicVault(API, basicAuroraVault, tokenAddress, stakingAddress);
    case "erc20":
      const erc20 = new ethcall.Contract(tokenAddress, ERC20_ABI);
      return await getAuroraErc20(API, erc20, tokenAddress, stakingAddress);
  }
}

function getParameterCaseInsensitive(object, key) {
  return object[Object.keys(object)
    .find(k => k.toLowerCase() === key.toLowerCase())
  ];
}

function getUniPrices(tokens, prices, pool, chain="eth") {
  var t0 = getParameterCaseInsensitive(tokens,pool.token0);
  var p0 = getParameterCaseInsensitive(prices,pool.token0).usd ? getParameterCaseInsensitive(prices,pool.token0).usd : getParameterCaseInsensitive(prices,pool.token0);
  var t1 = getParameterCaseInsensitive(tokens,pool.token1);
  var p1 = getParameterCaseInsensitive(prices,pool.token1).usd ? getParameterCaseInsensitive(prices,pool.token1).usd : getParameterCaseInsensitive(prices,pool.token1);
  if (p0 == null && p1 == null) {
    console.log(`Missing prices for tokens ${pool.token0} and ${pool.token1}.`);
    return undefined;
  }
  if (t0 == null || t0.decimals == null) {
    console.log(`Missing information for token ${pool.token0}.`);
    return undefined;
  }
  if (t1 == null || t1.decimals == null) {
    console.log(`Missing information for token ${pool.token1}.`);
    return undefined;
  }
  var q0 = pool.q0 / 10 ** t0.decimals;
  var q1 = pool.q1 / 10 ** t1.decimals;
  if (p0 == null)
  {
      p0 = q1 * p1 / q0;
      prices[pool.token0] = { usd : p0 };
  }
  if (p1 == null)
  {
      p1 = q0 * p0 / q1;
      prices[pool.token1] = { usd : p1 };
  }
  var tvl = q0 * p0 + q1 * p1;
  var price = tvl / pool.totalSupply;
  prices[pool.address] = { usd : price };
  var staked_tvl = pool.staked * price;
  let stakeTokenTicker = `[${t0.symbol}]-[${t1.symbol}]`;
  if (pool.is1inch) stakeTokenTicker += " 1INCH LP";
  else if (pool.symbol.includes("TETHYSLP")) stakeTokenTicker += " TETHYS LP";
  else if (pool.symbol.includes("LSLP")) stakeTokenTicker += " LSLP";
  else if (pool.symbol.includes("vAMM")) stakeTokenTicker += " vAMM";
  else if (pool.symbol.includes("sAMM")) stakeTokenTicker += " sAMM";
  else if (pool.symbol.includes("Wigo-LP")) stakeTokenTicker += " Wigo-LP";
  else if (pool.symbol.includes("DXS")) stakeTokenTicker += " DXS-LP";
  else if (pool.symbol.includes("HAUS-LP")) stakeTokenTicker += " HAUS-LP";
  else if (pool.symbol.includes("HBLP")) stakeTokenTicker += " Huckleberry LP";
  else if (pool.symbol.includes("BLP")) stakeTokenTicker += " BLP";
  else if (pool.symbol.includes("BEAM-LP")) stakeTokenTicker += " BEAM-LP";
  else if (pool.symbol.includes("ZDEXLP")) stakeTokenTicker += " ZooDex LP";
  else if (pool.symbol.includes("OperaSwap")) stakeTokenTicker += " Opera Swap LP";
  else if (pool.symbol.includes("SLP")) stakeTokenTicker += " SLP";
  else if (pool.symbol.includes("Farmtom-LP")) stakeTokenTicker += " Farmtom LP";
  else if (pool.symbol.includes("Cake")) stakeTokenTicker += " Cake LP";
  else if (pool.name.includes("Value LP")) stakeTokenTicker += " Value LP";
  else if (pool.name.includes("Duneswap LP Token")) stakeTokenTicker += " Duneswap LP";
  else if (pool.name.includes("Lizard LPs")) stakeTokenTicker += " LLP";
  else if (pool.name.includes("Gemkeeper LP Token")) stakeTokenTicker += " GLP";
  else if (pool.symbol.includes("PGL")) stakeTokenTicker += " PGL";
  else if (pool.symbol.includes("JLP")) stakeTokenTicker += " JLP";
  else if (pool.symbol.includes("CS-LP")) stakeTokenTicker += " CSS LP";
  else if (pool.symbol.includes("DFYN")) stakeTokenTicker += " DFYN LP";
  else if (pool.symbol.includes("NMX-LP")) stakeTokenTicker += " NMX LP";
  else if (pool.symbol.includes("SPIRIT")) stakeTokenTicker += " SPIRIT LP";
  else if (pool.symbol.includes("TOMB-V2-LP")) stakeTokenTicker += " TOMB-V2 LP";
  else if (pool.symbol.includes("spLP")) stakeTokenTicker += " SPOOKY LP";
  else if (pool.symbol.includes("Lv1")) stakeTokenTicker += " STEAK LP";
  else if (pool.symbol.includes("PLP")) stakeTokenTicker += " Pure Swap LP";
  else if (pool.symbol.includes("Field-LP")) stakeTokenTicker += " Yield Fields LP";
  else if (pool.symbol.includes("UPT")) stakeTokenTicker += " Unic Swap LP";
  else if (pool.symbol.includes("ELP")) stakeTokenTicker += " ELK LP";
  else if (pool.symbol.includes("BenSwap")) stakeTokenTicker += " BenSwap LP";
  else if (pool.name.includes("MISTswap LP Token")) stakeTokenTicker += " MistSwap LP";
  else if (pool.name.includes("TANGOswap LP Token")) stakeTokenTicker += " TangoSwap LP";
  else if (pool.name.includes("Flare LP Token")) stakeTokenTicker += " FLP LP";
  else if (pool.symbol.includes("BRUSH-LP")) stakeTokenTicker += " BRUSH LP";
  else if (pool.symbol.includes("APE-LP")) stakeTokenTicker += " APE LP";
  else if (pool.symbol.includes("Galaxy-LP")) stakeTokenTicker += " Galaxy LP";
  else if (pool.symbol.includes("KUS-LP")) stakeTokenTicker += " KUS LP";
  else if (pool.symbol.includes("KoffeeMug")) stakeTokenTicker += " KoffeeMug";
  else if (pool.symbol.includes("DMM-LP")) stakeTokenTicker += " DMM-LP";
  else if (pool.symbol.includes("ZLK-LP")) stakeTokenTicker += " ZLK-LP";
  else if (pool.symbol.includes("CAT-LP")) stakeTokenTicker += " PolyCat LP";
  else if (pool.symbol.includes("VLP")) stakeTokenTicker += " AURO LP";
  else if (pool.symbol.includes("DLP")) stakeTokenTicker += " DLP";
  else if (pool.symbol.includes("ULP")) stakeTokenTicker += " Ubeswap LP Token";
  else if (pool.symbol.includes("LOVE LP")) stakeTokenTicker += " Love Boat Love LP Token";
  else if (pool.symbol.includes("Proto-LP")) stakeTokenTicker += " ProtoFi LP Token";
  else if (pool.symbol.includes("SOUL-LP")) stakeTokenTicker += " Soulswap LP Token";
  else if (pool.symbol.includes("lv_")) stakeTokenTicker += " Lixir LP Token";
  else if (pool.symbol.includes("LOOT-LP")) stakeTokenTicker += " Loot LP Token";
  else if (pool.symbol.includes("MIMO-LP")) stakeTokenTicker += " Mimo LP Token";
  else if (pool.symbol.includes("HLP")) stakeTokenTicker += " Hades Swap LP Token";
  else if (pool.name.includes("1BCH LP Token")) stakeTokenTicker += " 1BCH LP";
  else if (pool.symbol.includes("MOCHI-LP")) stakeTokenTicker += " Mochi LP Token";
  else if (pool.symbol.includes("SMUG-LP")) stakeTokenTicker += " Smug LP Token";
  else if (pool.symbol.includes("VVS-LP")) stakeTokenTicker += " VVS LP Token";
  else if (pool.symbol.includes("CNO-LP")) stakeTokenTicker += " CNO LP Token";
  else if (pool.symbol.includes("Crona-LP")) stakeTokenTicker += " Crona LP Token";
  else if (pool.symbol.includes("Genesis-LP")) stakeTokenTicker += " Genesis LP Token";
  else if (pool.symbol.includes("Wagyu-LP")) stakeTokenTicker += " Wagyu LP Token";
  else if (pool.symbol.includes("OLP")) stakeTokenTicker += " Oolong LP Token";
  else if (pool.symbol.includes("TLP") && !pool.name.includes("Thorus LP")) stakeTokenTicker += " Trisolaris LP Token";
  else if (pool.symbol.includes("TLP") && pool.name.includes("Thorus LP")) stakeTokenTicker += " Thorus LP Token";
  else if (pool.symbol.includes("SCLP")) stakeTokenTicker += " SwapperChan LP Token";
  else if (pool.symbol.includes('VENOM-LP')) stakeTokenTicker += ' VENOM-LP Token';
  else if (pool.symbol.includes('Charm-LP')) stakeTokenTicker += ' OmniDex LP Token';
  else if (pool.symbol.includes('zLP')) stakeTokenTicker += ' Zappy LP Token';
  else if (pool.symbol.includes('MEERKAT-LP')) stakeTokenTicker += ' MEERKAT-LP Token';
  else if (pool.symbol.includes('STELLA LP')) stakeTokenTicker += ' STELLA LP Token';
  else stakeTokenTicker += " Uni LP";
  return {
      t0: t0,
      p0: p0,
      q0  : q0,
      t1: t1,
      p1: p1,
      q1  : q1,
      price: price,
      tvl : tvl,
      staked_tvl : staked_tvl,
      stakeTokenTicker : stakeTokenTicker,
      /*
      print_price(chain="eth", decimals, customURLs) {
        const t0address = t0.symbol == "ETH" ? "ETH" : t0.address;
        const t1address = t1.symbol == "ETH" ? "ETH" : t1.address;
        if (customURLs) {
          const poolUrl = `${customURLs.info}/${pool.address}`
          const helperUrls = [
            `${customURLs.add}/${t0address}/${t1address}`,
            `${customURLs.remove}/${t0address}/${t1address}`,
            `${customURLs.swap}?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ]
          const helperHrefs = helperUrls.length == 0 ? "" :
            ` <a href='${helperUrls[0]}' target='_blank'>[+]</a> <a href='${helperUrls[1]}' target='_blank'>[-]</a> <a href='${helperUrls[2]}' target='_blank'>[<=>]</a>`
          _print(`<a href='${poolUrl}' target='_blank'>${stakeTokenTicker}</a>${helperHrefs} Price: $${formatMoney(price)} TVL: $${formatMoney(tvl)}`);
          _print(`${t0.symbol} Price: $${displayPrice(p0)}`);
          _print(`${t1.symbol} Price: $${displayPrice(p1)}`);
          _print(`Staked: ${pool.staked.toFixed(decimals ? decimals : 4)} ${pool.symbol} ($${formatMoney(staked_tvl)})`);

        }
        else {
          const poolUrl = pool.is1inch ? "https://1inch.exchange/#/dao/pools" :
          pool.symbol.includes("TETHYSLP") ?  `https://info.tethys.finance/pair/${pool.address}` :
          pool.symbol.includes("LSLP") ? `https://info.linkswap.app/pair/${pool.address}` :
            pool.symbol.includes("SLP") ? (
              {
                "eth": `http://analytics.sushi.com/pairs/${pool.address}`,
                "arbitrum": `http://analytics-arbitrum.sushi.com/pairs/${pool.address}`,
                "bsc": `http://analytics-ftm.sushi.com/pairs/${pool.address}`,
                "fantom": `http://analytics-ftm.sushi.com/pairs/${pool.address}`,
                "matic": `http://analytics-polygon.sushi.com/pairs/${pool.address}`,
                "xdai": `https://analytics-xdai.sushi.com/pairs/${pool.address}`,
                "harmony": `https://analytics-harmony.sushi.com/pairs/${pool.address}`
              }[chain]) :
              pool.symbol.includes("Cake") ?  `https://pancakeswap.info/pair/${pool.address}` :
              pool.symbol.includes("CAT-LP") ?  `https://polycat.finance` :
              pool.symbol.includes("PGL") ?  `https://info.pangolin.exchange/#/pair/${pool.address}` :
              pool.symbol.includes("DMM-LP") ?  (
                {
                  "eth": `https://info.dmm.exchange/pair/${t0address}_${t1address}`,
                  "avax": `https://avax-info.dmm.exchange/pair/${t0address}_${t1address}`,
                  "bsc": `https://bsc-info.dmm.exchange/pair/${t0address}_${t1address}`,
                  "matic": `https://polygon-info.dmm.exchange/pair/${t0address}_${t1address}`
                }
              [chain]):
              pool.symbol.includes("CS-LP") ?  `https://app.coinswap.space/#/` :
              pool.symbol.includes("NMX-LP") ?  `https://nomiswap.io/swap` :
              pool.symbol.includes("vAMM") ?  (
                {
                  "fantom": `https://solidly.exchange`,
                  "metis": `https://hermes.maiadao.io/#/swap`
                }
              [chain]):
              pool.symbol.includes("sAMM") ?  (
                {
                  "fantom" : `https://solidly.exchange`,
                  "metis" : `https://hermes.maiadao.io/#/swap`
                }
              [chain]):
              pool.symbol.includes("ZLK-LP") ?  `https://dex.zenlink.pro/#/info/overview` :
              pool.name.includes("Value LP") ?  `https://info.vswap.fi/pool/${pool.address}` :
              pool.name.includes("Duneswap LP Token") ?  `https://explorer.emerald.oasis.dev/token/${pool.address}` :
              pool.name.includes("Lizard LPs") ?  `https://explorer.emerald.oasis.dev/token/${pool.address}` :
              pool.name.includes("Gemkeeper LP Token") ?  `https://explorer.emerald.oasis.dev/token/${pool.address}` :
              pool.name.includes("Flare LP Token") ?  `https://analytics.solarflare.io/pairs/${pool.address}` :
              pool.symbol.includes("SCLP") ?  `https://analytics.swapperchan.com/pairs/${pool.address}` :
              pool.symbol.includes("DXS") ?  `https://dxstats.eth.link/#/pair/${pool.address}` :
              pool.name.includes("Ubeswap") ?  `https://info.ubeswap.org/pair/${pool.address}` :
              pool.symbol.includes("Farmtom-LP") ?  `https://farmtom.com/swap` :
              pool.symbol.includes("TOMB-V2-LP") ?  `https://swap.tomb.com/#/swap` :
              pool.name.includes("OperaSwap") ?  `https://www.operaswap.finance/` :
              pool.symbol.includes("SPIRIT") ?  `https://swap.spiritswap.finance/#/swap` :
              pool.symbol.includes("spLP") ?  `https://info.spookyswap.finance/pair/${pool.address}` :
              pool.symbol.includes("HAUS-LP") ?  `https://app.next-gen.finance/info/pool/${pool.address}` :
              pool.symbol.includes("Lv1") ?  `https://info.steakhouse.finance/pair/${pool.address}` :
              pool.symbol.includes("JLP") ?  `https://cchain.explorer.avax.network/address/${pool.address}` :
              pool.symbol.includes("ELP") ?  `https://app.elk.finance/#/swap` :
              pool.symbol.includes("BRUSH-LP") ?  `https://paintswap.finance` :
              pool.symbol.includes("PLP") ?  `https://exchange.pureswap.finance/#/swap` :
              pool.symbol.includes("HBLP") ?  `https://info.huckleberry.finance/pair/${pool.address}` :
              pool.symbol.includes("Wigo-LP") ?  `https://wigoswap.io/analytics/pool/${pool.address}` :
              pool.symbol.includes("BLP") ?  `https://info.bakeryswap.org/#/pair/${pool.address}` :
              pool.symbol.includes("BEAM-LP") ?  `https://analytics.beamswap.io/pairs/${pool.address}` :
              pool.symbol.includes("KUS-LP") ?  `https://kuswap.info/pair/#/${pool.address}` :
              pool.symbol.includes("Wagyu-LP") ?  `https://exchange.wagyuswap.app/info/pool/${pool.address}` :
              pool.symbol.includes("OLP") ?  `https://info.oolongswap.com/#/pair/${pool.address}` :
              pool.symbol.includes("KoffeeMug") ?  `https://koffeeswap.exchange/#/pro` :
              pool.symbol.includes("APE-LP") ?  `https://info.apeswap.finance/pair/${pool.address}` :
              pool.symbol.includes("VLP") ?  `https://info.viralata.finance/pair/${pool.address}` :
              pool.symbol.includes("DLP") ?  `https://app.dodoex.io/pool/list?${pool.address}` :
              pool.symbol.includes("ZDEXLP") ?  `https://charts.zoocoin.cash/?exchange=ZooDex&pair=${t0.symbol}-${t1.symbol}` :
              pool.symbol.includes("Field-LP") ?  `https://exchange.yieldfields.finance/#/swap` :
              pool.symbol.includes("MIMO-LP") ?  `https://v2.info.mimo.exchange/pair/${pool.address}` :
              pool.symbol.includes("MOCHI-LP") ?  `https://harmony.mochiswap.io/` :
              pool.symbol.includes("SMUG-LP") ?  `https://smugswap.com/` :
              pool.symbol.includes("UPT") ?  `https://www.app.unic.ly/#/discover` :
              pool.symbol.includes("lv_") ?  `https://app.lixir.finance/vaults/${pool.address}` :
              pool.symbol.includes("HLP") ?  `https://analytics.hadesswap.finance/pairs/${pool.address}` :
              pool.symbol.includes("LOOT-LP") ?  `https://analytics.lootswap.finance/pair/${pool.address}` :
              pool.symbol.includes("JEWEL-LP") ? `https://explorer.harmony.one/address/${pool.address}`:
              pool.symbol.includes("VVS-LP") ?  `https://vvs.finance/info/farm/${pool.address}` :
              pool.symbol.includes("CNO-LP") ?  `https://chronoswap.org/info/pool/${pool.address}` :
              pool.symbol.includes("TLP") && !pool.name.includes("Thorus LP") ?  `https://aurorascan.dev/address/${pool.address}` :
              pool.symbol.includes("TLP") && !pool.name.includes("Thorus LP") ?  `https://snowtrace.io/address/${pool.address}` :
              pool.symbol.includes("Crona-LP") ?  `https://app.cronaswap.org/info/${pool.address}` : //wait for real version
              pool.symbol.includes("Genesis-LP") ?  `https://app.cronaswap.org/info/${pool.address}` : //wait for real version
              pool.symbol.includes("BenSwap") ? ({
                "bsc": `https://info.benswap.finance/pair/${pool.address}`,
                "smartbch": `https://info.benswap.cash/pair/${pool.address}`
              }[chain]) :
              pool.name.includes("MISTswap LP Token") ?  `https://analytics.mistswap.fi/pairs/${pool.address}` :
              pool.symbol.includes("Proto-LP")? ({
                "matic":`https://polygonscan.com/${pool.address}` ,
                "fantom": `https://fantomscan.com/address/${pool.address}`
            }[chain]):
              pool.symbol.includes("Galaxy-LP") ? (
                {
                    "bsc": `https://bsc-exchange.galaxyfinance.one/#/swap`,
                    "heco": `https://heco-exchange.galaxyfinance.one/#/swap`,
                    "matic": `https://polygon-exchange.galaxyfinance.one/#/swap`,
                    "fantom": `https://fantom-exchange.galaxyfinance.one/#/swap`,
                }[chain]) :
              pool.symbol.includes("LOVE LP") ? ({
                "matic": `https://info.loveboat.exchange/pair/${pool.address}`
              }[chain]) : pool.symbol.includes('VENOM-LP')
          ? `https://info.viper.exchange/pairs/${pool.address}`
          : chain == "matic" ? `https://info.quickswap.exchange/pair/${pool.address}` :
          pool.symbol.includes("Charm-LP") ?  `https://analytics.omnidex.finance/pair/${pool.address}` :
          pool.symbol.includes("zLP") ?  `https://analytics.zappy.finance/pair/${pool.address}` :
            `http://v2.uniswap.info/pair/${pool.address}`;
          const helperUrls = pool.is1inch ? [] :
          pool.symbol.includes("LSLP") ? [
            `https://linkswap.app/#/add/${t0address}/${t1address}`,
            `https://linkswap.app/#/remove/${t0address}/${t1address}`,
            `https://linkswap.app/#/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ] :
          pool.symbol.includes("BenSwap") ? ({
            "bsc": [
              `https://dex.benswap.finance/#/add/${t0address}/${t1address}`,
              `https://dex.benswap.finance/#/remove/${t0address}/${t1address}`,
              `https://dex.benswap.finance/#/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
            ],
            "smartbch": [
              `https://dex.benswap.cash/#/add/${t0address}/${t1address}`,
              `https://dex.benswap.cash/#/remove/${t0address}/${t1address}`,
              `https://dex.benswap.cash/#/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
            ]
          }[chain]) :
          pool.symbol.includes("vAMM") ? ({
            "fantom" : [
              `https://solidly.exchange/liquidity/create`,
              `https://solidly.exchange/liquidity/create`,
              `https://solidly.exchange/swap`
            ],
            "metis" : [
              `https://hermes.maiadao.io/#/add/${t0address}/${t1address}/false`,
              `https://hermes.maiadao.io/#/find`,
              `https://hermes.maiadao.io/#/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
            ]
          } [chain]):
          pool.symbol.includes("sAMM") ? ({
            "fantom" : [
              `https://solidly.exchange/liquidity/create`,
              `https://solidly.exchange/liquidity/create`,
              `https://solidly.exchange/swap`
            ],
            "metis" : [
              `https://hermes.maiadao.io/#/add/${t0address}/${t1address}/true`,
              `https://hermes.maiadao.io/#/find`,
              `https://hermes.maiadao.io/#/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
            ]
          } [chain]):
          pool.symbol.includes("HBLP") ? [
            `https://www.huckleberry.finance/#/add/${t0address}/${t1address}`,
            `https://www.huckleberry.finance/#/remove/${t0address}/${t1address}`,
            `https://www.huckleberry.finance/#/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ] :
          pool.symbol.includes("DXS") ? [
            `https://swapr.eth.link/#/add/${t0address}/${t1address}`,
            `https://swapr.eth.link/#/remove/${t0address}/${t1address}`,
            `https://swapr.eth.link/#/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ] :
          pool.symbol.includes("HAUS-LP") ? [
            `https://app.next-gen.finance/add/${t0address}/${t1address}`,
            `https://app.next-gen.finance/remove/${t0address}/${t1address}`,
            `https://app.next-gen.finance/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ] :
          pool.symbol.includes("TOMB-V2-LP") ? [
            `https://swap.tomb.com/#/add/${t0address}/${t1address}`,
            `https://swap.tomb.com/#/remove/${t0address}/${t1address}`,
            `https://swap.tomb.com/#/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ] :
          pool.symbol.includes("Wigo-LP") ? [
            `https://wigoswap.io/add/${t0address}/${t1address}`,
            `https://wigoswap.io/remove/${t0address}/${t1address}`,
            `https://wigoswap.io/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ] :
          pool.symbol.includes("ZLK-LP") ? [
            `https://dex.zenlink.pro/#/swap`,
            `https://dex.zenlink.pro/#/swap`,
            `https://dex.zenlink.pro/#/swap`
          ] :
          pool.symbol.includes("Farmtom-LP") ? [
            `https://farmtom.com/add/${t0address}/${t1address}`,
            `https://farmtom.com/remove/${t0address}/${t1address}`,
            `https://farmtom.com/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ] :
          pool.symbol.includes("BEAM-LP") ? [
            `https://app.beamswap.io/exchange/add/${t0address}/${t1address}`,
            `https://app.beamswap.io/exchange/remove/${t0address}/${t1address}`,
            `https://app.beamswap.io/exchange/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ] :
          pool.symbol.includes("NMX-LP") ? [
            `https://nomiswap.io/liquidity/add/${t0address}/${t1address}`,
            `https://nomiswap.io/liquidity/remove/${t0address}/${t1address}`,
            `https://nomiswap.io/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ] :
          pool.symbol.includes("TLP") && !pool.name.includes("Thorus LP") ? [
            `https://www.trisolaris.io/#/add/${t0address}/${t1address}`,
            `https://www.trisolaris.io/#/remove/${t0address}/${t1address}`,
            `https://www.trisolaris.io/#/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ] :
          pool.symbol.includes("TLP") && pool.name.includes("Thorus LP") ? [
            `https://app.thorus.fi/add/${t0address}/${t1address}`,
            `https://app.thorus.fi/remove/${t0address}/${t1address}`,
            `https://app.thorus.fi/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ] :
          pool.symbol.includes("VVS") ? [
            `https://vvs.finance/add/${t0address}/${t1address}`,
            `https://vvs.finance/remove/${t0address}/${t1address}`,
            `https://vvs.finance/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ] :
          pool.symbol.includes("CNO") ? [
            `https://chronoswap.org/add/${t0address}/${t1address}`,
            `https://chronoswap.org/remove/${t0address}/${t1address}`,
            `https://chronoswap.org/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ] :
          pool.symbol.includes("OLP") ? [
            `https://oolongswap.com/#/add/${t0address}/${t1address}`,
            `https://oolongswap.com/#/remove/${t0address}/${t1address}`,
            `https://oolongswap.com/#/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ] :
          pool.symbol.includes("SCLP") ? [
            `https://swapperchan.com/add/${t0address}/${t1address}`,
            `https://swapperchan.com/remove/${t0address}/${t1address}`,
            `https://swapperchan.com/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ] :
          pool.symbol.includes("Crona-LP") ? [
            `https://app.cronaswap.org/add/${t0address}/${t1address}`,
            `https://app.cronaswap.org/remove/${t0address}/${t1address}`,
            `https://app.cronaswap.org/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ] :
          pool.symbol.includes("Genesis-LP") ? [
            `https://app.cronaswap.org/add/${t0address}/${t1address}`,
            `https://app.cronaswap.org/remove/${t0address}/${t1address}`,
            `https://app.cronaswap.org/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ] :
          pool.symbol.includes("BLP") ? [
            `https://www.bakeryswap.org/#/add/${t0address}/${t1address}`,
            `https://www.bakeryswap.org/#/remove/${t0address}/${t1address}`,
            `https://www.bakeryswap.org/#/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ] :
          pool.symbol.includes("HLP") ? [
            `https://hadesswap.finance/add/${t0address}/${t1address}`,
            `https://hadesswap.finance/remove/${t0address}/${t1address}`,
            `https://hadesswap.finance/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ] :
          pool.symbol.includes("MOCHI-LP") ? [
            `https://harmony.mochiswap.io/add/${t0address}/${t1address}`,
            `https://harmony.mochiswap.io/remove/${t0address}/${t1address}`,
            `https://harmony.mochiswap.io/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ] :
          pool.symbol.includes("TETHYSLP") ? [
            `https://tethys.finance/pool/add?inputCurrency=${t0address}&outputCurrency=${t1address}`,
            `https://tethys.finance/pool/remove?inputCurrency=${t0address}&outputCurrency=${t1address}`,
            `https://tethys.finance/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ] :
          pool.name.includes("Duneswap LP Token") ? [
            `https://www.duneswap.com/exchange/add/${t0address}/${t1address}`,
            `https://www.duneswap.com/exchange/remove/${t0address}/${t1address}`,
            `https://www.duneswap.com/exchange/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ] :
          pool.name.includes("Lizard LPs") ? [
            `https://app.lizard.exchange/add/${t0address}/${t1address}`,
            `https://app.lizard.exchange/remove/${t0address}/${t1address}`,
            `https://app.lizard.exchange/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ] :
          pool.name.includes("Gemkeeper LP Token") ? [
            `https://app.gemkeeper.finance/#/add/${t0address}/${t1address}`,
            `https://app.gemkeeper.finance/#/remove/${t0address}/${t1address}`,
            `https://app.gemkeeper.finance/#/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ] :
          pool.symbol.includes("SMUG-LP") ? [
            `https://smugswap.com/add/${t0address}/${t1address}`,
            `https://smugswap.com/remove/${t0address}/${t1address}`,
            `https://smugswap.com/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ] :
          pool.symbol.includes("lv_") ? [
            `https://app.lixir.finance/vaults/${pool.address}`,
            `https://app.lixir.finance/vaults/${pool.address}`,
            `https://app.uniswap.org/#/swap?inputCurrency=${t0address}&outputCurrency=${t1address}&use=v2`
          ] :
          pool.symbol.includes("DMM-LP") ? [
            `https://dmm.exchange/#/add/${t0address}/${t1address}/${pool.address}`,
            `https://dmm.exchange/#/remove/${t0address}/${t1address}/${pool.address}`,
            `https://dmm.exchange/#/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ]:
          pool.symbol.includes("Wagyu-LP") ? [
            `https://exchange.wagyuswap.app/add/${t0address}/${t1address}`,
            `https://exchange.wagyuswap.app/remove/${t0address}/${t1address}`,
            `https://exchange.wagyuswap.app/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ]:
          pool.symbol.includes("LOOT-LP") ? [
            `https://legacy.lootswap.finance/#/add/${t0address}/${t1address}`,
            `https://legacy.lootswap.finance/#/remove/${t0address}/${t1address}`,
            `https://legacy.lootswap.finance/#/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ]:
          pool.symbol.includes("CAT-LP") ? [
            `https://trade.polycat.finance/#/add/${t0address}/${t1address}`,
            `https://trade.polycat.finance/#/remove/${t0address}/${t1address}`,
            `https://trade.polycat.finance/#/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ] :
          pool.symbol.includes("APE-LP") ? [
            `https://app.apeswap.finance/add/${t0address}/${t1address}`,
            `https://app.apeswap.finance/remove/${t0address}/${t1address}`,
            `https://app.apeswap.finance/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ] :
          pool.symbol.includes("ULP") ? [
            `https://app.ubeswap.org/#/add/${t0address}/${t1address}`,
            `https://app.ubeswap.org/#/remove/${t0address}/${t1address}`,
            `https://app.ubeswap.org/#/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ] :
          pool.symbol.includes("VLP") ? [
            `https://app.viralata.finance/add/${t0address}/${t1address}`,
            `https://app.viralata.finance/remove/${t0address}/${t1address}`,
            `https://app.viralata.finance/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ] :
          pool.symbol.includes("ZDEXLP") ? [
            `https://dex.zoocoin.cash/pool/add?inputCurrency=${t0address}&outputCurrency=${t1address}`,
            `https://dex.zoocoin.cash/pool/remove?inputCurrency=${t0address}&outputCurrency=${t1address}`,
            `https://dex.zoocoin.cash/orders/market?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ] :
          pool.symbol.includes("Cake") ? [
            `https://pancakeswap.finance/add/${t0address}/${t1address}`,
            `https://pancakeswap.finance/remove/${t0address}/${t1address}`,
            `https://pancakeswap.finance/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ] :
          pool.symbol.includes("Lv1") ? [ // adding before matic
            `https://swap.steakhouse.finance/#/add/${t0address}/${t1address}`,
            `https://swap.steakhouse.finance/#/remove/${t0address}/${t1address}`,
            `https://swap.steakhouse.finance/#/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ] :
          pool.name.includes("Value LP") ? [
            `https://bsc.valuedefi.io/#/add/${t0address}/${t1address}`,
            `https://bsc.valuedefi.io/#/remove/${t0address}/${t1address}`,
            `https://bsc.valuedefi.io/#/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ] :
          pool.symbol.includes("PGL") ? [
            `https://app.pangolin.exchange/#/add/${t0address}/${t1address}`,
            `https://app.pangolin.exchange/#/remove/${t0address}/${t1address}`,
            `https://app.pangolin.exchange/#/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ] :
          pool.symbol.includes("OperaSwap") ? [
            `https://exchange.operaswap.finance/#/add/${t0address}/${t1address}`,
            `https://exchange.operaswap.finance/#/remove/${t0address}/${t1address}`,
            `https://exchange.operaswap.finance/#/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ] :
          pool.symbol.includes("ELP") ? [
            `https://app.elk.finance/#/add/${t0address}/${t1address}`,
            `hhttps://app.elk.finance/#/remove/${t0address}/${t1address}`,
            `https://app.elk.finance/#/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ] :
          pool.symbol.includes("JEWEL-LP") ? [
            `https://game.defikingdoms.com/#/add/${t0address}/${t1address}`,
            `https://game.defikingdoms.com/#/remove/${t0address}/${t1address}`,
            `https://game.defikingdoms.com/#/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ] :
          pool.symbol.includes("DLP") ? [
            `https://app.dodoex.io/pool/list?${pool.address}`,
            `https://app.dodoex.io/pool/list?${pool.address}`,
            `https://app.dodoex.io/exchange/${t0address}-${t1address}`
          ] :
          pool.symbol.includes("CS-LP") ? [
            `https://app.coinswap.space/#/add/${t0address}/${t1address}`,
            `https://app.coinswap.space/#/remove/${t0address}/${t1address}`,
            `https://app.coinswap.space/#/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ] :
          pool.symbol.includes("SLP") ? [
            `https://app.sushi.com/add/${t0address}/${t1address}`,
            `https://app.sushi.com/remove/${t0address}/${t1address}`,
            `https://app.sushi.com/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ] :
          pool.symbol.includes("SPIRIT") ? [
            `https://swap.spiritswap.finance/add/${t0address}/${t1address}`,
            `https://swap.spiritswap.finance/remove/${t0address}/${t1address}`,
            `https://swap.spiritswap.finance/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ] :
          pool.symbol.includes("SOUL-LP") ? [
            `https://app.soulswap.finance/add/${t0address}/${t1address}`,
            `https://app.soulswap.finance/remove/${t0address}/${t1address}`,
            `https://app.soulswap.finance/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ] :
          pool.symbol.includes("spLP") ? [
            `https://spookyswap.finance/add/${t0address}/${t1address}`,
            `https://spookyswap.finance/remove/${t0address}/${t1address}`,
            `https://spookyswap.finance/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ] :
          pool.symbol.includes("PLP") ? [
            `https://exchange.pureswap.finance/#/add/${t0address}/${t1address}`,
            `https://exchange.pureswap.finance/#/remove/${t0address}/${t1address}`,
            `https://exchange.pureswap.finance/#/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ] :
          pool.symbol.includes("Proto-LP") ? ({
            "matic":[
            `https://dex.protofi.app/#/add/${t0address}/${t1address}`,
            `https://dex.protofi.app/#/remove/${t0address}/${t1address}`,
            `https://dex.protofi.app/#/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ],
          "fantom":[
            `https://fantomdex.protofi.app/#/add/${t0address}/${t1address}`,
            `https://fantomdex.protofi.app/#/remove/${t0address}/${t1address}`,
            `https://fantomdex.protofi.app/#/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ]}[chain])  :
          pool.symbol.includes("Field-LP") ? [
            `https://exchange.yieldfields.finance/#/add/${t0address}/${t1address}`,
            `https://exchange.yieldfields.finance/#/remove/${t0address}/${t1address}`,
            `https://exchange.yieldfields.finance/#/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ] :
          pool.symbol.includes("UPT") ? [
            `https://www.app.unic.ly/#/add/${t0address}/${t1address}`,
            `https://www.app.unic.ly/#/remove/${t0address}/${t1address}`,
            `https://www.app.unic.ly/#/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ] :
          pool.symbol.includes("MIMO-LP") ? [
            `https://exchange.zoomswap.io/#/add/${t0address}/${t1address}`,
            `https://exchange.zoomswap.io/#/remove/${t0address}/${t1address}`,
            `https://exchange.zoomswap.io/#/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ] :
          pool.symbol.includes("BRUSH-LP") ? [
            `https://exchange.paintswap.finance/#/add/${t0address}/${t1address}`,
            `https://exchange.paintswap.finance/#/remove/${t0address}/${t1address}`,
            `https://exchange.paintswap.finance/#/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ] :
          pool.symbol.includes("BenSwap") ? ({
            "bsc": [
              `https://dex.benswap.finance/#/add/${t0address}/${t1address}`,
              `https://dex.benswap.finance/#/remove/${t0address}/${t1address}`,
              `https://dex.benswap.finance/#/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
            ],
            "smartbch": [
              `https://dex.benswap.cash/#/add/${t0address}/${t1address}`,
              `https://dex.benswap.cash/#/remove/${t0address}/${t1address}`,
              `https://dex.benswap.cash/#/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
            ]
          }[chain]) :
          pool.name.includes("MISTswap LP Token") ? [
            `https://app.mistswap.fi/add/${t0address}/${t1address}`,
            `https://app.mistswap.fi/remove/${t0address}/${t1address}`,
            `https://app.mistswap.fi/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ] :
          pool.name.includes("TANGOswap LP Token") ? [
            `https://tangoswap.cash/add/${t0address}/${t1address}`,
            `https://tangoswap.cash/remove/${t0address}/${t1address}`,
            `https://tangoswap.cash/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ] :
          pool.name.includes("Flare LP Token") ? [
            `https://www.solarflare.io/exchange/add/${t0address}/${t1address}`,
            `https://www.solarflare.io/exchange/remove/${t0address}/${t1address}`,
            `https://www.solarflare.io/exchange/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ] :
          pool.name.includes("1BCH LP Token") ? [
            `https://1bch.com/add/${t0address}/${t1address}`,
            `https://1bch.com/remove/${t0address}/${t1address}`,
            `https://1bch.com/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ] :
          pool.symbol.includes("Galaxy-LP") ? ({
            "bsc": [
              `https://bsc-exchange.galaxyfinance.one/#/add/${t0address}/${t1address}`,
              `https://bsc-exchange.galaxyfinance.one/#/remove/${t0address}/${t1address}`,
              `https://bsc-exchange.galaxyfinance.one/#/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
            ],
            "heco": [
              `https://heco-exchange.galaxyfinance.one/#/add/${t0address}/${t1address}`,
              `https://heco-exchange.galaxyfinance.one/#/remove/${t0address}/${t1address}`,
              `https://heco-exchange.galaxyfinance.one/#/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
            ],
            "polygon": [
              `https://polygon-exchange.galaxyfinance.one/#/add/${t0address}/${t1address}`,
              `https://polygon-exchange.galaxyfinance.one/#/remove/${t0address}/${t1address}`,
              `https://polygon-exchange.galaxyfinance.one/#/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
            ],
            "fantom": [
              `https://fantom-exchange.galaxyfinance.one/#/add/${t0address}/${t1address}`,
              `https://fantom-exchange.galaxyfinance.one/#/remove/${t0address}/${t1address}`,
              `https://fantom-exchange.galaxyfinance.one/#/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
            ]
          }[chain]) :
          chain=='matic'? [
            `https://quickswap.exchange/#/add/${t0address}/${t1address}`,
            `https://quickswap.exchange/#/remove/${t0address}/${t1address}`,
            `https://quickswap.exchange/#/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ] :
          pool.symbol.includes("KUS-LP") ? [
              `https://kuswap.finance/#/add/${t0address}/${t1address}`,
              `https://kuswap.finance/#/remove/${t0address}/${t1address}`,
              `https://kuswap.finance/#/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ] :
          pool.symbol.includes("KoffeeMug") ? [
            `https://koffeeswap.exchange/#/add/${t0address}/${t1address}`,
            `https://koffeeswap.exchange/#/remove/${t0address}/${t1address}`,
            `https://koffeeswap.exchange/#/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
        ] :
          pool.symbol.includes("LOVE LP") ? ({
            "matic": [
              `https://loveboat.exchange/#/add/${t0address}/${t1address}`,
              `https://loveboat.exchange/#/remove/${t0address}/${t1address}`,
              `https://loveboat.exchange/#/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
            ]
          }[chain]) : pool.symbol.includes('VENOM-LP')
          ? [
              `https://viper.exchange/#/add/${t0address}/${t1address}`,
              `https://viper.exchange/#/remove/${t0address}/${t1address}`,
              `https://viper.exchange/#/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`,
            ] :
          pool.symbol.includes("Charm-LP") ? [
            `https://omnidex.finance/add/${t0address}/${t1address}`,
            `https://omnidex.finance/remove/${t0address}/${t1address}`,
            `https://omnidex.finance/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ] :
          pool.symbol.includes("zLP") ? [
            `https://zappy.finance/liquidity/pool?main=${t0address}&base=${t1address}`,
            `https://zappy.finance/liquidity/pool?main=${t0address}&base=${t1address}`,
            `https://zappy.finance/swap?from=${t0address}&to=${t1address}`
          ] :
          [ `https://app.uniswap.org/#/add/v2/${t0address}/${t1address}`,
            `https://app.uniswap.org/#/remove/v2/${t0address}/${t1address}`,
            `https://app.uniswap.org/#/swap?inputCurrency=${t0address}&outputCurrency=${t1address}&use=v2` ]

          const helperHrefs = helperUrls.length == 0 ? "" :
            ` <a href='${helperUrls[0]}' target='_blank'>[+]</a> <a href='${helperUrls[1]}' target='_blank'>[-]</a> <a href='${helperUrls[2]}' target='_blank'>[<=>]</a>`
          _print(`<a href='${poolUrl}' target='_blank'>${stakeTokenTicker}</a>${helperHrefs} Price: $${formatMoney(price)} TVL: $${formatMoney(tvl)}`);
          _print(`${t0.symbol} Price: $${displayPrice(p0)}`);
          _print(`${t1.symbol} Price: $${displayPrice(p1)}`);
          _print(`Staked: ${pool.staked.toFixed(decimals ? decimals : 4)} ${pool.symbol} ($${formatMoney(staked_tvl)})`);
        }
      },
      pair_links(chain="eth", decimals, customURLs) {
        const t0address = t0.symbol == "ETH" ? "ETH" : t0.address;
        const t1address = t1.symbol == "ETH" ? "ETH" : t1.address;
        if (customURLs) {
          const poolUrl = `${customURLs.info}/${pool.address}`
          const helperUrls = [
            `${customURLs.add}/${t0address}/${t1address}`,
            `${customURLs.remove}/${t0address}/${t1address}`,
            `${customURLs.swap}?inputCurrency=${t0address}&outputCurrency=${t1address}`
          ]
          return {
            pair_link: `<a href='${poolUrl}' target='_blank'>${stakeTokenTicker}</a>`,
            add_liquidity_link: `<a href='${helperUrls[0]}' target='_blank'>[+]</a>`,
            remove_liquidity_link: `<a href='${helperUrls[1]}' target='_blank'>[-]</a>`,
            swap_link: `<a href='${helperUrls[2]}' target='_blank'>[<=>]</a>`,
            token0: t0.symbol,
            price0: `$${displayPrice(p0)}`,
            token1: t1.symbol,
            price1: `$${displayPrice(p1)}`,
            total_staked: `${pool.staked.toFixed(4)}`,
            total_staked_dollars: `$${formatMoney(staked_tvl)}`,
            tvl: `$${formatMoney(tvl)}`
          }
        }
        else {
          const poolUrl = pool.is1inch ? "https://1inch.exchange/#/dao/pools" :
            pool.symbol.includes("LSLP") ? `https://info.linkswap.app/pair/${pool.address}` :
              pool.symbol.includes("SLP") ?  `http://analytics.sushi.com/pairs/${pool.address}` :
                pool.symbol.includes("Cake") ?  `https://pancakeswap.info/pair/${pool.address}` :
                  pool.symbol.includes("PGL") ?  `https://info.pangolin.exchange/#/pair/${pool.address}` :
                    pool.symbol.includes("CS-LP") ?  `https://app.coinswap.space/#/` :
                      pool.name.includes("Value LP") ?  `https://info.vswap.fi/pool/${pool.address}` :
                        pool.name.includes("BLP") ?  `https://info.bakeryswap.org/#/pair/${pool.address}` :
                          pool.symbol.includes("BenSwap") ? ({
                            "bsc": `https://info.benswap.finance/pair/${pool.address}`,
                            "smartbch": `https://info.benswap.cash/pair/${pool.address}`
                          }[chain]) :
                          pool.name.includes("MISTswap LP Token") ?  `http://analytics.mistswap.fi/pairs/${pool.address}` :
                          pool.symbol.includes("Galaxy-LP") ? ({
                            "bsc": `https://bsc-exchange.galaxyfinance.one/#/swap`,
                            "heco": `https://heco-exchange.galaxyfinance.one/#/swap`,
                            "polygon": `https://polygon-exchange.galaxyfinance.one/#/swap`,
                            "fantom": `https://fantom-exchange.galaxyfinance.one/#/swap`
                          }[chain]) :
                            chain == "matic" ? `https://info.quickswap.exchange/pair/${pool.address}` :
                          pool.symbol.includes("Charm-LP") ?  `https://analytics.omnidex.finance/pair/${pool.address}` :
                          pool.symbol.includes("zLP") ?  `https://analytics.omnidex.finance/pair/${pool.address}` :
                              `http://v2.uniswap.info/pair/${pool.address}`;
          const helperUrls = pool.is1inch ? [] :
            pool.symbol.includes("LSLP") ? [
                `https://linkswap.app/#/add/${t0address}/${t1address}`,
                `https://linkswap.app/#/remove/${t0address}/${t1address}`,
                `https://linkswap.app/#/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
              ] :
              pool.symbol.includes("Cake") ? [
                  `https://pancakeswap.finance/add/${t0address}/${t1address}`,
                  `https://pancakeswap.finance/remove/${t0address}/${t1address}`,
                  `https://pancakeswap.finance/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
                ] :
                chain=='matic'? [
                    `https://quickswap.exchange/#/add/${t0address}/${t1address}`,
                    `https://quickswap.exchange/#/remove/${t0address}/${t1address}`,
                    `https://quickswap.exchange/#/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
                  ] :
                  pool.name.includes("Value LP") ? [
                      `https://bsc.valuedefi.io/#/add/${t0address}/${t1address}`,
                      `https://bsc.valuedefi.io/#/remove/${t0address}/${t1address}`,
                      `https://bsc.valuedefi.io/#/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
                    ] :
                    pool.symbol.includes("PGL") ? [
                        `https://app.pangolin.exchange/#/add/${t0address}/${t1address}`,
                        `https://app.pangolin.exchange/#/remove/${t0address}/${t1address}`,
                        `https://app.pangolin.exchange/#/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
                      ] :
                      pool.symbol.includes("CS-LP") ? [
                          `https://app.coinswap.space/#/add/${t0address}/${t1address}`,
                          `https://app.coinswap.space/#/remove/${t0address}/${t1address}`,
                          `https://app.coinswap.space/#/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
                        ] :
                        pool.symbol.includes("SLP") ? [
                            `https://app.sushi.com/add/${t0address}/${t1address}`,
                            `https://app.sushi.com/remove/${t0address}/${t1address}`,
                            `https://app.sushi.com/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
                          ] :
                          pool.symbol.includes("BenSwap") ? ({
                            "bsc": [
                              `https://dex.benswap.finance/#/add/${t0address}/${t1address}`,
                              `https://dex.benswap.finance/#/remove/${t0address}/${t1address}`,
                              `https://dex.benswap.finance/#/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
                            ],
                            "smartbch": [
                              `https://dex.benswap.cash/#/add/${t0address}/${t1address}`,
                              `https://dex.benswap.cash/#/remove/${t0address}/${t1address}`,
                              `https://dex.benswap.cash/#/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
                            ]
                          }[chain]) :
                        pool.name.includes("MISTswap LP Token") ? [
                          `https://app.mistswap.fi/add/${t0address}/${t1address}`,
                          `https://app.mistswap.fi/remove/${t0address}/${t1address}`,
                          `https://app.mistswap.fi/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
                        ] :
                        pool.name.includes("TANGOswap LP Token") ? [
                          `https://tangoswap.cash/add/${t0address}/${t1address}`,
                          `https://tangoswap.cash/remove/${t0address}/${t1address}`,
                          `https://tangoswap.cash/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
                        ] :
                        pool.symbol.includes("Galaxy-LP") ? ({
                            "bsc": [
                            `https://bsc-exchange.galaxyfinance.one/#/add/${t0address}/${t1address}`,
                            `https://bsc-exchange.galaxyfinance.one/#/remove/${t0address}/${t1address}`,
                            `https://bsc-exchange.galaxyfinance.one/#/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
                            ],
                            "heco": [
                            `https://heco-exchange.galaxyfinance.one/#/add/${t0address}/${t1address}`,
                            `https://heco-exchange.galaxyfinance.one/#/remove/${t0address}/${t1address}`,
                            `https://heco-exchange.galaxyfinance.one/#/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
                            ],
                            "polygon": [
                            `https://polygon-exchange.galaxyfinance.one/#/add/${t0address}/${t1address}`,
                            `https://polygon-exchange.galaxyfinance.one/#/remove/${t0address}/${t1address}`,
                            `https://polygon-exchange.galaxyfinance.one/#/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
                            ],
                            "fantom": [
                            `https://fantom-exchange.galaxyfinance.one/#/add/${t0address}/${t1address}`,
                            `https://fantom-exchange.galaxyfinance.one/#/remove/${t0address}/${t1address}`,
                            `https://fantom-exchange.galaxyfinance.one/#/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
                            ]
                        }[chain]) :
                        pool.symbol.includes("Charm-LP") ? [
                          `https://omnidex.finance/add/${t0address}/${t1address}`,
                          `https://omnidex.finance/remove/${t0address}/${t1address}`,
                          `https://omnidex.finance/swap?inputCurrency=${t0address}&outputCurrency=${t1address}`
                        ] :
                        pool.symbol.includes("zLP") ? [
                          `https://zappy.finance/liquidity/pool?main=${t0address}&base=${t1address}`,
                          `https://zappy.finance/liquidity/pool?main=${t0address}&base=${t1address}`,
                          `https://zappy.finance/swap?from=${t0address}&to=${t1address}`
                        ] :
                            [ `https://app.uniswap.org/#/add/v2/${t0address}/${t1address}`,
                              `https://app.uniswap.org/#/remove/v2/${t0address}/${t1address}`,
                              `https://app.uniswap.org/#/swap?inputCurrency=${t0address}&outputCurrency=${t1address}&use=v2` ]

          return {
            pair_link: `<a href='${poolUrl}' target='_blank'>${stakeTokenTicker}</a>`,
            add_liquidity_link: `<a href='${helperUrls[0]}' target='_blank'>[+]</a>`,
            remove_liquidity_link: `<a href='${helperUrls[1]}' target='_blank'>[-]</a>`,
            swap_link: `<a href='${helperUrls[2]}' target='_blank'>[<=>]</a>`,
            token0: t0.symbol,
            price0: `$${displayPrice(p0)}`,
            token1: t1.symbol,
            price1: `$${displayPrice(p1)}`,
            total_staked: `${pool.staked.toFixed(4)}`,
            total_staked_dollars: `$${formatMoney(staked_tvl)}`,
            tvl: `$${formatMoney(tvl)}`
          }

        }
      },
      print_contained_price(userStaked) {
        var userPct = userStaked / pool.totalSupply;
        var q0user = userPct * q0;
        var q1user = userPct * q1;
        _print(`Your LP tokens comprise of ${q0user.toFixed(4)} ${t0.symbol} + ${q1user.toFixed(4)} ${t1.symbol}`);
      }
    */
  }
}

const _print = function(message) {
  console.log(message);
}

function formatMoney(amount, decimalCount = 2, decimal = ".", thousands = ",") {
  try {
    decimalCount = Math.abs(decimalCount);
    decimalCount = isNaN(decimalCount) ? 2 : decimalCount;

    const negativeSign = amount < 0 ? "-" : "";

    let i = parseInt(amount = Math.abs(Number(amount) || 0).toFixed(decimalCount)).toString();
    let j = (i.length > 3) ? i.length % 3 : 0;

    return negativeSign + (j ? i.substr(0, j) + thousands : '') + i.substr(j).replace(/(\d{3})(?=\d)/g, "$1" + thousands) + (decimalCount ? decimal + Math.abs(amount - i).toFixed(decimalCount).slice(2) : "");
  } catch (e) {
    console.log(e)
  }
}

const displayPrice = price => {
  const priceDecimals = price == 0 ? 2 : price < 0.0001 ? 10 : price < 0.01 ? 6 : 2;
  return priceDecimals == 2 ? formatMoney(price) : price.toFixed(priceDecimals);
}

function calculateAPRs(
  rewardTokenTicker,
  rewardPrice,
  poolRewardsPerWeek,
  stakeTokenTicker,
  staked_tvl,
  userStaked,
  poolTokenPrice,
  fixedDecimals
) {
  fixedDecimals = fixedDecimals ? fixedDecimals : 2;
  const usdPerWeek = poolRewardsPerWeek * rewardPrice;
  const weeklyAPR = usdPerWeek / staked_tvl * 100;
  const dailyAPR = weeklyAPR / 7;
  const yearlyAPR = weeklyAPR * 52;

  return {
    usdPerWeek,
    rewardTokenTicker,
    poolRewardsPerWeek,
    dailyAPR,
    weeklyAPR,
    yearlyAPR
  }
}

/*
function printAPR(rewardTokenTicker, rewardPrice, poolRewardsPerWeek,
                  stakeTokenTicker, staked_tvl, userStaked, poolTokenPrice,
                  fixedDecimals) {
  var usdPerWeek = poolRewardsPerWeek * rewardPrice;
  fixedDecimals = fixedDecimals ? fixedDecimals : 2;
  _print(`${rewardTokenTicker} Per Week: ${poolRewardsPerWeek.toFixed(fixedDecimals)} ($${formatMoney(usdPerWeek)})`);
  var weeklyAPR = usdPerWeek / staked_tvl * 100;
  var dailyAPR = weeklyAPR / 7;
  var yearlyAPR = weeklyAPR * 52;
  _print(`APR: Day ${dailyAPR.toFixed(2)}% Week ${weeklyAPR.toFixed(2)}% Year ${yearlyAPR.toFixed(2)}%`);
  var userStakedUsd = userStaked * poolTokenPrice;
  var userStakedPct = userStakedUsd / staked_tvl * 100;
  _print(`You are staking ${userStaked.toFixed(fixedDecimals)} ${stakeTokenTicker} ($${formatMoney(userStakedUsd)}), ${userStakedPct.toFixed(2)}% of the pool.`);
  var userWeeklyRewards = userStakedPct * poolRewardsPerWeek / 100;
  var userDailyRewards = userWeeklyRewards / 7;
  var userYearlyRewards = userWeeklyRewards * 52;
  if (userStaked > 0) {
    _print(`Estimated ${rewardTokenTicker} earnings:`
        + ` Day ${userDailyRewards.toFixed(fixedDecimals)} ($${formatMoney(userDailyRewards*rewardPrice)})`
        + ` Week ${userWeeklyRewards.toFixed(fixedDecimals)} ($${formatMoney(userWeeklyRewards*rewardPrice)})`
        + ` Year ${userYearlyRewards.toFixed(fixedDecimals)} ($${formatMoney(userYearlyRewards*rewardPrice)})`);
  }
  return {
    userStakedUsd,
    totalStakedUsd : staked_tvl,
    userStakedPct,
    yearlyAPR,
    userYearlyUsd : userYearlyRewards * rewardPrice
  }
}
*/

const ID = function() {
  // Math.random should be unique because of its seeding algorithm.
  // Convert it to base 36 (numbers + letters), and grab the first 9 characters
  // after the decimal.
  return (
    '_' +
    Math.random()
      .toString(36)
      .substr(2, 9)
  )
}

function fetchChefPool(chefAbi, chefAddr, prices, tokens, poolInfo, poolIndex, poolPrices,
                       totalAllocPoints, rewardsPerWeek, rewardTokenTicker, rewardTokenAddress,
                       pendingRewardsFunction, fixedDecimals, claimFunction, chain="eth", depositFee=0, withdrawFee=0) {
  fixedDecimals = fixedDecimals ? fixedDecimals : 2;
  const sp = (poolInfo.stakedToken == null) ? null : getUniPrices(tokens, prices, poolInfo.stakedToken, chain);
  var poolRewardsPerWeek = poolInfo.allocPoints / totalAllocPoints * rewardsPerWeek;
  if (poolRewardsPerWeek == 0 && rewardsPerWeek != 0) return;
  const userStaked = poolInfo.userLPStaked ? poolInfo.userLPStaked : poolInfo.userStaked;
  const rewardPrice = getParameterCaseInsensitive(prices, rewardTokenAddress) ? getParameterCaseInsensitive(prices, rewardTokenAddress).usd : null;
  const staked_tvl = sp && sp.staked_tvl ? sp.staked_tvl : poolPrices.staked_tvl;

  // poolPrices.print_price(chain);
  // if(sp) sp.print_price(chain);
  const apr = calculateAPRs(rewardTokenTicker, rewardPrice, poolRewardsPerWeek, poolPrices.stakeTokenTicker,
    staked_tvl, userStaked, poolPrices.price, fixedDecimals);
  // if (poolInfo.userLPStaked > 0 && sp) sp.print_contained_price(userStaked);
  // if (poolInfo.userStaked > 0) poolPrices.print_contained_price(userStaked);

  return apr;
}

async function loadAuroraChefContract(
  API,
  tokens,
  prices,
  chef,
  chefAddress,
  chefAbi,
  rewardTokenTicker,
  rewardTokenFunction,
  rewardsPerBlockFunction,
  rewardsPerWeekFixed,
  pendingRewardsFunction,
  selectedPools)
{
  try {
    const chefContract = new ethers.Contract(chefAddress, chefAbi, API.provider);
    const poolCount = parseInt(await chefContract.poolLength(), 10);
    const totalAllocPoints = await chefContract.totalAllocPoint();
    const rewardTokenAddress = await chefContract.callStatic[rewardTokenFunction]();
    const rewardToken = await getAuroraToken(API, rewardTokenAddress, chefAddress);
    const rewardsPerWeek = rewardsPerWeekFixed
      ? rewardsPerWeekFixed
      : await chefContract.callStatic[rewardsPerBlockFunction]() / 10 ** rewardToken.decimals * 604800 / 3

    const poolInfos = await Promise.all([...Array(poolCount).keys()]
      .filter(x => selectedPools.indexOf(x.toString()) >= 0)
      .map(async (x) => await getAuroraPoolInfo(API, chefContract, chefAddress, x, pendingRewardsFunction)));

    var tokenAddresses = [].concat.apply([], poolInfos.filter(x => x.poolToken).map(x => x.poolToken.tokens));

    await Promise.all(tokenAddresses.map(async (address) => {
        tokens[address] = await getAuroraToken(API, address, chefAddress);
    }));

    const poolPrices = poolInfos.map(poolInfo => poolInfo.poolToken ? getUniPrices(tokens, prices, poolInfo.poolToken, "aurora") : undefined);

    const pools = [];
    for (let i = 0; i < poolCount; i++) {
      if (poolPrices[i]) {
        const apr = fetchChefPool(chefAbi, chefAddress, prices, tokens, poolInfos[i], i, poolPrices[i],
          totalAllocPoints, rewardsPerWeek, rewardTokenTicker, rewardTokenAddress,
          pendingRewardsFunction, null, null, "aurora", poolInfos[i].depositFee, poolInfos[i].withdrawFee);

        const { t0, t1, price, tvl, staked_tvl, stakeTokenTicker } = poolPrices[i];
        const token0 = {
          symbol: t0.symbol,
          name: t0.name
        };
        const token1 = {
          symbol: t1.symbol,
          name: t1.name
        };
        pools.push({
          token0,
          token1,
          // price,
          tvl: {
            pooled: tvl,
            staked: staked_tvl
          },
          stakingToken: stakeTokenTicker,
          ...apr
        });
      }
    }

    /*
    let totalUserStaked=0, totalStaked=0, averageApr=0;
    for (const a of aprs) {
      if (!isNaN(a.totalStakedUsd)) {
        totalStaked += a.totalStakedUsd;
      }
      if (a.userStakedUsd > 0) {
        totalUserStaked += a.userStakedUsd;
        averageApr += a.userStakedUsd * a.yearlyAPR / 100;
      }
    }
    averageApr = averageApr / totalUserStaked;
    console.log(`Total Staked: $${formatMoney(totalStaked)}`);
    if (totalUserStaked > 0) {
      console.log(`\nYou are staking a total of $${formatMoney(totalUserStaked)} at an average APR of ${(averageApr * 100).toFixed(2)}%`)
      console.log(`Estimated earnings:`
          + ` Day $${formatMoney(totalUserStaked*averageApr/365)}`
          + ` Week $${formatMoney(totalUserStaked*averageApr/52)}`
          + ` Year $${formatMoney(totalUserStaked*averageApr)}\n`);
    }
    */

    return {
      ...pools[0], // TODO: Adapt this when more pools are needed.
      prices,
      // poolCount,
      // totalUserStaked,
      // totalStaked,
      // averageApr
    };
  } catch (err) {
    console.log('Error in loadAuroraChefContract', err);
  }
}

module.exports = { getAPR } ;
