const { PromisePool } = require('@supercharge/promise-pool')
const { getDeployedPrograms, getProgramMappingValue, programTokenId } = require('../helper/chain/aleo')

const SHIELD_SWAP = 'shield_swap.aleo'

// Assets the AMM can hold are dynamic ARC-20 token programs, and the AMM addresses each by the token
// id its program name packs into (see programTokenId). Which of them the admin has approved is
// on-chain in `token_allowed`, but Aleo mappings cannot be enumerated by key, so the candidates come
// from the list of deployed programs and are then checked against the mapping one by one.
// https://shield.fi/docs/reference/mappings
const ARC20_PROGRAM = /(^|_)arc20_/

// Aleo has no on-chain decimal registry - "The AMM uses native token base units directly. It has no
// on-chain decimal scale or normalization registry."
// (https://shield.fi/docs/reference/constants-and-limits) - so decimals and the price feed of each
// approved token program are pinned here. USAD and USDCx are USD stablecoins on Aleo without their
// own DefiLlama price feed, so they are priced at parity.
const ASSETS = {
  'shield_swap_arc20_credits.aleo': { coingeckoId: 'aleo', decimals: 6 },
  'arc20_eth.aleo': { coingeckoId: 'ethereum', decimals: 18 },
  'arc20_sol.aleo': { coingeckoId: 'solana', decimals: 9 },
  'arc20_wbtc.aleo': { coingeckoId: 'bitcoin', decimals: 8 },
  'arc20_usdc.aleo': { coingeckoId: 'usd-coin', decimals: 6 },
  'arc20_usdt.aleo': { coingeckoId: 'tether', decimals: 6 },
  'shield_swap_arc20_wrapped_usdcx.aleo': { coingeckoId: 'usd-coin', decimals: 6 },
  'shield_swap_arc20_wrapped_usad.aleo': { coingeckoId: 'usd-coin', decimals: 6 },
}

const toBigInt = (v) => (v ? BigInt(String(v).replace(/u\d+$/, '')) : 0n)

async function retry(read, retries = 5) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read()
    } catch (e) {
      if (attempt >= retries - 1) throw e
      await new Promise((r) => setTimeout(r, 300 * 2 ** attempt))
    }
  }
}

/** Token programs the AMM admin has approved for pool creation. */
async function getApprovedTokenPrograms() {
  const deployed = (await getDeployedPrograms()).map((program) => program.id).filter((id) => ARC20_PROGRAM.test(id))
  // Union with the configured assets so that a future naming convention cannot silently drop one.
  const candidates = [...new Set([...deployed, ...Object.keys(ASSETS)])]

  const { results, errors } = await PromisePool.withConcurrency(3)
    .for(candidates)
    .process(async (program) => {
      const allowed = await retry(() => getProgramMappingValue(SHIELD_SWAP, 'token_allowed', programTokenId(program)))
      return String(allowed) === 'true' ? program : null
    })
  if (errors.length) throw errors[0]

  const approved = results.filter(Boolean)
  if (!approved.length) throw new Error('shield-swap: no approved token programs found on-chain')
  return approved
}

async function tvl(api) {
  const programs = await getApprovedTokenPrograms()

  const { results, errors } = await PromisePool.withConcurrency(3)
    .for(programs)
    .process(async (program) => ({
      program,
      balance: toBigInt(await retry(() => getProgramMappingValue(program, 'balances', SHIELD_SWAP))),
    }))
  if (errors.length) throw errors[0]

  for (const { program, balance } of results) {
    const asset = ASSETS[program]
    // An approved token with no balance yet is normal; one holding value must be priced.
    if (!asset) {
      if (balance > 0n) throw new Error(`shield-swap: ${program} holds ${balance} with no price feed configured`)
      continue
    }
    api.addCGToken(asset.coingeckoId, Number(balance) / 10 ** asset.decimals)
  }
}

module.exports = {
  timetravel: false,
  misrepresentedTokens: true,
  methodology:
    'TVL is the aggregate balance held by shield_swap.aleo in every token program the AMM admin has approved on-chain, read directly from Aleo chain state. It includes pool capital, accrued fees, and funds awaiting claims.',
  aleo: { tvl },
}
