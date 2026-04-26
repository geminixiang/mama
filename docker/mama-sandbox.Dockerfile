FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV NVM_DIR=/root/.nvm
ENV CLOUDSDK_CORE_DISABLE_PROMPTS=1

SHELL ["/bin/bash", "-lc"]

RUN apt-get update && apt-get install -y --no-install-recommends \
  bash \
  build-essential \
  ca-certificates \
  curl \
  git \
  gnupg \
  jq \
  less \
  openssh-client \
  python-is-python3 \
  tini \
  unzip \
  xz-utils \
  zip \
  && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

ARG NODE_VERSION=22

RUN curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash \
  && source "$NVM_DIR/nvm.sh" \
  && nvm install "$NODE_VERSION" \
  && nvm alias default "$NODE_VERSION" \
  && NODE_BIN_DIR="$NVM_DIR/versions/node/$(nvm version "$NODE_VERSION")/bin" \
  && ln -sf "$NODE_BIN_DIR/node" /usr/local/bin/node \
  && ln -sf "$NODE_BIN_DIR/npm" /usr/local/bin/npm \
  && ln -sf "$NODE_BIN_DIR/npx" /usr/local/bin/npx \
  && ln -sf "$NODE_BIN_DIR/corepack" /usr/local/bin/corepack \
  && npm install -g @googleworkspace/cli \
  && ln -sf "$NODE_BIN_DIR/gws" /usr/local/bin/gws

RUN curl -LsSf https://astral.sh/uv/install.sh | sh \
  && ln -sf /root/.local/bin/uv /usr/local/bin/uv \
  && ln -sf /root/.local/bin/uvx /usr/local/bin/uvx

RUN curl -fsSL https://sdk.cloud.google.com | bash -s -- --disable-prompts --install-dir=/root \
  && ln -sf /root/google-cloud-sdk/bin/gcloud /usr/local/bin/gcloud \
  && ln -sf /root/google-cloud-sdk/bin/gsutil /usr/local/bin/gsutil \
  && ln -sf /root/google-cloud-sdk/bin/bq /usr/local/bin/bq

WORKDIR /workspace

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
