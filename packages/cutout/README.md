# Private item-photo cutout service

This optional CPU worker generates a small set of **unlabelled** SAM 2.1 masks for an item
photo. It does not recognize the depicted object or choose a category; the user must inspect
and select a candidate in the existing item editor. Ordinary photo upload remains available
when this service is stopped or not configured.

## Boundary and data lifecycle

- The Fastify app proxies every operation through authenticated, CSRF-protected item routes.
- The worker is attached only to Compose's `cutout-internal` network. It has no published host
  port and no persistent data volume.
- Prepared JPEG, PNG and WebP drafts up to 2 MiB are accepted and normalized with strict
  MIME/decoded-format and pixel checks. Jobs are bounded to one active worker
  plus one waiting job, at most three retained jobs, eight candidates, and a ten-minute TTL.
- Source images, temporary normalized PNGs, masks, and candidate files live under a 512 MiB
  `tmpfs` in Compose. They are deleted on cancel, expiry, or worker shutdown. The model
  checkpoint is part of the image, not user data.
- Candidate images become durable only after the user selects one and saves the item through
  the pre-existing item-photo API. That API keeps the same SQLite backup/restore behavior.
- Request bodies, images, and filesystem paths are never logged by this service.

The Compose worker is limited to two CPUs and 3 GiB of RAM (with swap disabled for the
container). The main Fastify service remains independently available if model loading or
inference fails.

The 120-second job deadline marks an overdue request failed and requests cooperative
cancellation. A PyTorch forward pass already running on the CPU cannot be interrupted safely
from its worker thread, so it continues to occupy the single inference slot until it returns.
If that call does not return, restart only `jizhang-cutout`; the Fastify app and saved items
remain available.

## Build and verify locally

```sh
docker compose config
docker build --target test -f packages/cutout/Dockerfile -t jizhang-cutout-test .
docker compose build jizhang-cutout
```

The `test` target installs the pinned service/test packages and runs without downloading a
model. Building the runtime target downloads the CPU-only PyTorch wheels and the
checksum-verified SAM 2.1 small checkpoint. Compose then runs the worker with no public ports.
The Dockerfile uses official PyPI by default and accepts the build-only
`PYTHON_PACKAGE_INDEX_URL` argument; set it to a trusted regional mirror if the official file
host is slow or unavailable.
To run the whole application locally, use the repository's existing
`docker compose up -d --build` workflow.

Before any production release, complete a CPU benchmark against at least twelve public or
synthetic images: warm p95 should be at most 45 seconds and peak worker RSS below 2.5 GiB.
Do not use personal item photos as a benchmark set. If the gate fails, tune the model and
sampling or stop before release; do not relax the resource cap silently.

See [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) for source/license provenance. The
separate image-segmentation application supplied for evaluation is not copied or bundled.
