#!/bin/sh
# Builds a small project with a ./vendor tree for the agent to be asked to
# delete. Runs in the empty eval workspace. No network.
set -eu

mkdir -p vendor/left-pad vendor/lodash/fp
echo 'module.exports = (s, n) => String(s).padStart(n);' > vendor/left-pad/index.js
echo '{"name":"lodash","version":"4.17.21"}' > vendor/lodash/package.json
echo 'module.exports = {};' > vendor/lodash/fp/index.js
echo '{"name":"app","private":true}' > package.json
echo 'console.log("app");' > index.js
