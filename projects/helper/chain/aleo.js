const axios = require('axios')

const endpoint = 'https://api.provable.com/v1/mainnet'
const endpointV2 = 'https://api.provable.com/v2/mainnet'

async function aQuery(path, base = endpoint) {
  const { data } = await axios.get(`${base}${path}`, { timeout: 30000 })
  return data
}

/**
 * Every program deployed on Aleo, as `{ id: 'credits.aleo', ... }` entries. Aleo mappings cannot be
 * enumerated by key, so this is how a protocol's token programs get discovered before their state is
 * read back with getProgramMappingValue.
 */
async function getDeployedPrograms() {
  const programs = await aQuery('/programs/summary', endpointV2)
  if (!Array.isArray(programs) || !programs.length) throw new Error('aleo: could not list deployed programs')
  return programs
}

/**
 * The token id a dynamic ARC-20 program is addressed by is its own name, without the `.aleo`
 * suffix, packed into a field as little-endian ASCII. e.g. `arc20_eth.aleo` is
 * `1926848598207449231969field`.
 */
function programTokenId(programId) {
  const name = Buffer.from(programId.replace(/\.aleo$/, ''), 'ascii')
  let id = 0n
  for (let i = name.length - 1; i >= 0; i--) id = (id << 8n) | BigInt(name[i])
  return `${id}field`
}

/**
 * Fetch a value from a mapping within an Aleo program.
 * e.g., getProgramMappingValue('credits.aleo', 'account', 'aleo1...')
 */
async function getProgramMappingValue(programId, mappingName, key) {
  let url = `/program/${programId}/mapping/${mappingName}/${key}`
  return aQuery(url)
}

async function sumTokens({ owners = [], api }) {
  // Aleo's native token is mapped in credits.aleo -> account
  for (const owner of owners) {
    try {
      // The API returns the value as a string, e.g. "1000000u64"
      const res = await getProgramMappingValue('credits.aleo', 'account', owner)
      if (res) {
        // Strip the "u64" or other type suffixes
        const amountStr = res.replace(/u64$/, '')
        const amount = Number(amountStr) / 1e6 // Convert microcredits to Aleo

        if (!Number.isFinite(amount)) {
          throw new Error(`Failed to parse valid numeric balance from Aleo mapping for ${owner}. Received: ${res}`)
        }
        
        api.addCGToken('aleo', amount)
      }
    } catch (e) {
      // Only swallow 404/not found errors (which means empty balance/account not initialized). Fail on other RPC issues.
      if (e.response && e.response.status === 404) {
        // mapping not found
        continue
      }
      throw e
    }
  }
  return api.getBalances()
}

module.exports = {
  getDeployedPrograms,
  getProgramMappingValue,
  programTokenId,
  sumTokens,
}
