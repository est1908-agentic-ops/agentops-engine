# Builds worker/gateway/control as one buildx invocation instead of three
# separate `docker build` calls, so BuildKit builds the shared `deps`/`base`
# stages from images/engine/Dockerfile once and fans the three divergent
# targets out concurrently instead of the workflow serializing them.
group "default" {
  targets = ["worker", "gateway", "control"]
}

target "worker" {
  context    = "."
  dockerfile = "images/engine/Dockerfile"
  target     = "worker"
}

target "gateway" {
  context    = "."
  dockerfile = "images/engine/Dockerfile"
  target     = "gateway"
}

target "control" {
  context    = "."
  dockerfile = "images/engine/Dockerfile"
  target     = "control"
}
