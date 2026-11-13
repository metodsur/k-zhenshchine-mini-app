// Scoped CF Bot API transport. Never setGlobalDispatcher: legacy bot/club calls are untouched.
const { Agent } = require('undici');
let cloudDispatcher;
function cfCloudDispatcher() {
  cloudDispatcher ||= new Agent({ connect: { family: 4, autoSelectFamily: false, timeout: 30000 } });
  return cloudDispatcher;
}
module.exports = { cfCloudDispatcher };
