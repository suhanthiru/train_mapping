# Rust Kalman sidecar — multi-stage, slim runtime image.
FROM rust:1.96 AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release

FROM debian:bookworm-slim
COPY --from=build /src/target/release/kalman-rs /usr/local/bin/kalman-rs
EXPOSE 8092
CMD ["kalman-rs"]
