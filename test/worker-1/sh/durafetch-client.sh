#!/bin/bash
# Note: Add `127.0.0.1  durafetch_worker-1.localhost` to /etc/hosts
# - The subdomain is used for routing and simulates the subdomain of production requests.

cd "$(dirname "$0")"

# Allows `ws://` (no TLS for `ws://x.localhost`).
NODE_ENV=development durafetch --config-file ./durafetch-config.json

#durafetch --config-file ./durafetch-config.json
