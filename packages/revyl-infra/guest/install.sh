#!/bin/bash
# Installs the Open-Inspect sandbox runtime into a Revyl macOS computer, as the
# computer's own account (passwordless sudo, Homebrew owned by it). The
# computer is then stopped and saved as the base snapshot; /workspace and /app
# exist from the next boot on (synthetic.conf).
# Usage: install.sh <checkout of this repository>
set -euo pipefail

SRC="$(cd "${1:?usage: install.sh <checkout>}" && pwd)"
OI=/opt/openinspect
APP=$OI/app
USER_HOME=/Users/computer
export HOME=$USER_HOME HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 \
  HOMEBREW_NO_INSTALL_UPGRADE=1

for formula in gh ripgrep bash uv node@24 coreutils; do
  brew install "$formula"
done
NODE_BIN="$(brew --prefix node@24)/bin"
export PATH="$NODE_BIN:/opt/homebrew/bin:$PATH"

sudo mkdir -p $OI /usr/local/bin
sudo chown -R "$(id -un)" $OI /usr/local/bin
mkdir -p $APP/plugins $APP/opencode-deps $OI/bin $OI/tools $OI/revyl

uv venv --python 3.12 --allow-existing $OI/python
uv pip install --python $OI/python/bin/python "$SRC/packages/sandbox-runtime"
ln -sfn "$($OI/python/bin/python -c 'import sandbox_runtime; print(sandbox_runtime.__path__[0])')" $APP/sandbox_runtime

cp "$SRC/packages/sandbox-images/locks/tools/"package*.json $OI/tools/
(cd $OI/tools && npm ci --ignore-scripts --no-audit --no-fund &&
  node node_modules/opencode-ai/postinstall.mjs && node node_modules/bun/install.js)
for command in opencode bun bunx pnpm; do
  ln -sf "$OI/tools/node_modules/.bin/$command" "/usr/local/bin/$command"
done
cp "$SRC/packages/sandbox-images/locks/plugins/"package*.json $APP/opencode-deps/
(cd $APP/opencode-deps && npm ci --ignore-scripts --no-audit --no-fund)
mkdir -p "$USER_HOME/.config/opencode" "$USER_HOME/.local/bin" "$USER_HOME/.cache/openinspect/scm"
cp -a $APP/opencode-deps/. "$USER_HOME/.config/opencode/"

printf '%s\n' '#!/bin/sh' "exec $OI/python/bin/python -m sandbox_runtime.credentials.git_credential_helper \"\$@\"" \
  >/usr/local/bin/oi-git-credentials
chmod 0755 /usr/local/bin/oi-git-credentials
git config --global credential.helper /usr/local/bin/oi-git-credentials
git config --global credential.useHttpPath true

$OI/python/bin/python - "$APP/openinspect-runtime-environment.json" "$USER_HOME" "$NODE_BIN" <<'PY'
import json, sys
path, home, node_bin = sys.argv[1:]
json.dump(
    {
        "HOME": home,
        "XDG_CONFIG_HOME": f"{home}/.config",
        "NODE_ENV": "development",
        "PYTHONPATH": "/app",
        "NODE_PATH": "/opt/openinspect/tools/node_modules",
        "PATH": ":".join([
            "/opt/openinspect/bin", "/opt/openinspect/python/bin", node_bin,
            "/opt/openinspect/tools/node_modules/.bin", f"{home}/.local/bin",
            "/usr/local/bin", "/opt/homebrew/opt/coreutils/libexec/gnubin", "/opt/homebrew/bin",
            "/usr/bin", "/bin", "/usr/sbin", "/sbin",
        ]),
        "OPENINSPECT_BIN_INSTALL_DIR": f"{home}/.local/bin",
        "OI_SCM_CRED_CACHE_DIR": f"{home}/.cache/openinspect/scm",
        "OPENINSPECT_REAL_GH": "/opt/homebrew/bin/gh",
    },
    open(path, "w"),
)
PY

GUEST="$SRC/packages/revyl-infra/guest"
install -m 0755 "$GUEST/launcher.sh" "$GUEST/start-session.sh" "$GUEST/run-runtime.py" $OI/revyl/
mv $OI/revyl/start-session.sh $OI/revyl/start-session
sudo install -m 0644 -o root -g wheel "$GUEST/ai.openinspect.sandbox.plist" /Library/LaunchDaemons/
printf 'workspace\tUsers/computer/workspace\napp\topt/openinspect/app\n' | sudo tee /etc/synthetic.conf >/dev/null
sudo chmod 0644 /etc/synthetic.conf

$OI/python/bin/python -B -c 'import sandbox_runtime.entrypoint' && opencode --version && gh --version | head -1
echo "Open-Inspect runtime installed; stop and snapshot this computer."
