# Proof: SeaweedFS local start

Image: `chrislusf/seaweedfs:4.54`, command `weed mini -dir=/data -s3 -ip.bind=0.0.0.0` (see `compose.yaml`). Image already pulled.

Measurement, three runs, each from no container and no volume. Per run, on the host:

    docker compose -p grimoire down -v
    s=$(date +%s.%N); docker compose -p grimoire up -d seaweedfs
    until curl -s --aws-sigv4 aws:amz:us-east-1:s3 --user "$GRIMOIRE_DEV_S3_ACCESS_KEY:$GRIMOIRE_DEV_S3_SECRET_KEY" http://127.0.0.1:8333/ | grep -q ListAllMyBucketsResult; do sleep 0.05; done
    e=$(date +%s.%N)   # seconds = e - s, computed with awk

The development credentials are the ones in `compose.yaml` (values in `.env`).

Values in seconds: 4.004, 4.038, 4.079 (median 4.038).

weed-mini-start-seconds: 4.038
s3-list-buckets: pass

`s3-list-buckets`: a signed ListBuckets from the host returned HTTP 200 with a ListAllMyBucketsResult body (observed in the polling loop above and with curl directly).
The AWS CLI against the local endpoint also completed make bucket, put, get, delete object and remove bucket.

Healthcheck: a signed ListBuckets run inside the container (curl with `--aws-sigv4`, `-f` so non-2xx fails) whose body must contain ListAllMyBucketsResult. An unsigned request returns 403 AccessDenied, so a pass proves the gateway serves authenticated S3 requests.

## Limitations

The measured time includes container creation and the poll interval (50 ms); the image pull is excluded. It is from one machine with other containers running.
