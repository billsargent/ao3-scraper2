# CI and signed releases

## Continuous integration

`.github/workflows/ci.yml` runs:

- Strict TypeScript build and unit/API tests
- Vite production build
- Playwright Chromium workflows
- Production dependency audit
- MariaDB 10.11 migrations and integration suite
- App and web container builds with BuildKit cache

The full OTW pipeline remains a manual/local job because its image and Elasticsearch requirements are significantly heavier:

```bash
npm run test:full-pipeline
```

## Signed container releases

Push a semantic tag such as:

```bash
git tag v0.2.0
git push origin v0.2.0
```

The release workflow builds multi-architecture images:

```text
ghcr.io/<owner>/<repository>-app:<tag>
ghcr.io/<owner>/<repository>-web:<tag>
```

Each image includes BuildKit provenance and an SBOM, receives a GitHub artifact attestation, and is signed keylessly with Sigstore Cosign using GitHub OIDC.

Verify a published image:

```bash
cosign verify \
  --certificate-identity-regexp='https://github.com/.+/.github/workflows/release.yml@refs/tags/v.+' \
  --certificate-oidc-issuer='https://token.actions.githubusercontent.com' \
  ghcr.io/<owner>/<repository>-app@sha256:<digest>
```

Production Compose currently builds locally by default. To deploy published images, override `image:` values or provide a small Compose override pinned to immutable digests. Never deploy only by a mutable `latest` tag.
