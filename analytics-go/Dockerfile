# Go anomaly-detection service — multi-stage, static binary on distroless.
FROM golang:1.25 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /out/analytics .

FROM gcr.io/distroless/static-debian12
COPY --from=build /out/analytics /analytics
ENV NODE_WS_URL=ws://train_3d_map:8088
ENV DATA_DIR=/data/nyc
ENV DB_PATH=/data/analytics.db
ENV PYTHON_URL=http://analytics-py:8091
ENV HTTP_ADDR=:8090
EXPOSE 8090
ENTRYPOINT ["/analytics"]
