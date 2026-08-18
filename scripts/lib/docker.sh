#!/usr/bin/env bash
# shellcheck shell=bash
if docker info >/dev/null 2>&1; then
  DOCKER=(docker)
elif command -v sudo >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
  DOCKER=(sudo docker)
else
  echo "Docker is installed but this user cannot reach the daemon." >&2
  echo "Start Docker, add your user to the docker group, or configure passwordless sudo for Docker." >&2
  return 1 2>/dev/null || exit 1
fi
