#!/bin/sh
# The image's entrypoint (Dockerfile). node-bind is node with cap_net_bind_service, for a node that
# serves port 53, 80 or 443 as the non-root `node` user. A container that drops every capability
# can't exec it at all, so there it is plain node: such a node binds no low port anyway.
if /usr/local/bin/node-bind -e 0 2>/dev/null; then
    exec /usr/local/bin/node-bind /app/bin/mesh-serve.mjs "$@"
fi
exec node /app/bin/mesh-serve.mjs "$@"
