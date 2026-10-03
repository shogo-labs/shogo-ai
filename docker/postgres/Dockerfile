# Platform Postgres for docker-compose and local k8s: the official Alpine
# image plus pgvector (semantic search over team chat).
#
# Stays on Alpine on purpose: existing volumes were initialized by
# postgres:16-alpine, and moving them to a glibc image changes text collation
# and silently invalidates btree indexes on text columns.
FROM postgres:16-alpine

ARG PGVECTOR_VERSION=0.8.2

RUN apk add --no-cache --virtual .build-deps build-base git \
  && git clone --depth 1 --branch v${PGVECTOR_VERSION} https://github.com/pgvector/pgvector.git /tmp/pgvector \
  && make -C /tmp/pgvector OPTFLAGS="" with_llvm=no \
  && make -C /tmp/pgvector install with_llvm=no \
  && rm -rf /tmp/pgvector \
  && apk del .build-deps
