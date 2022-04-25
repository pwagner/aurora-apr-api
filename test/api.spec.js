const chai = require('chai');
const should = chai.should();
const expect = chai.expect;
const sinon = require('sinon');
const request = require('supertest');
const server = require('../index.js');


describe('API Endpoints', () => {

  describe('GET /', function() {
    it('responds with all json fields', async function() {
      this.timeout(20000);
      const response = await request(server)
        .get('/')
        .set('Accept', 'application/json');
      expect(response.headers['content-type']).to.match(/json/);
      expect(response.status).to.equal(200);

      const {
        blockNumber,
        // multiplier,
        // rewardsPerWeek,
        prices,
        token0,
        token1,
        tvl,
        stakingToken,
        rewardTokenTicker,
        poolRewardsPerWeek,
        dailyAPR,
        weeklyAPR,
        yearlyAPR,
      } = response.body
      expect(blockNumber).to.be.gt(0);
      // expect(multiplier).to.be.gt(0);
      // expect(rewardsPerWeek).to.be.gt(0);
      const tokenAddresses = Object.keys(prices);
      expect(tokenAddresses.length).to.be.gt(1);
      expect(token0).to.exist;
      expect(token1).to.exist;
      expect(tvl).to.exist;
      expect(tvl.pooled).to.be.gt(tvl.staked); // TODO: Separate tests
      expect(stakingToken).to.exist;
      expect(rewardTokenTicker).to.exist;
      expect(poolRewardsPerWeek).to.be.gt(0);
      expect(dailyAPR).to.be.gt(0);
      expect(weeklyAPR).to.be.gt(0);
      expect(yearlyAPR).to.be.gt(0);
    });
  });

  it('404 everything else', (done) => {
    request(server)
      .get('/foo/bar')
      .expect(404, done);
  });
});
