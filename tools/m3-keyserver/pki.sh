#!/bin/sh
# Test CA and a server certificate for the test key server (names: keyserver, localhost, 127.0.0.1), written to the directory given as $1
# (test-results/m3/pki, ignored by git). Throwaway keys; world-readable on purpose so the non-root container user can read them.
set -eu
dir="$1"
# Reused only while both certificates are still valid for at least another hour (they last 2 days); an expired set is made again.
if [ -s "$dir/ca.pem" ] && [ -s "$dir/ca.key" ] && [ -s "$dir/server.pem" ] && [ -s "$dir/server.key" ] && openssl x509 -checkend 3600 -noout -in "$dir/ca.pem" >/dev/null && openssl x509 -checkend 3600 -noout -in "$dir/server.pem" >/dev/null; then exit 0; fi
mkdir -p "$dir"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$dir/ca.key" -out "$dir/ca.pem" -days 2 -subj "/CN=grimoire m3 test CA" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -keyout "$dir/server.key" -out "$dir/server.csr" -subj "/CN=keyserver" 2>/dev/null
printf 'subjectAltName=DNS:keyserver,DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\n' > "$dir/san.ext"
openssl x509 -req -in "$dir/server.csr" -CA "$dir/ca.pem" -CAkey "$dir/ca.key" -CAcreateserial -out "$dir/server.pem" -days 2 -extfile "$dir/san.ext" 2>/dev/null
chmod 644 "$dir"/*
