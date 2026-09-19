"""Locker offline reader. Requires cryptography. Passwords are read from the terminal."""
import argparse
import getpass
import hashlib
import json
import struct
from pathlib import Path
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

def open_vault(path, phrase):
    data = Path(path).read_bytes()
    if data[:8] != b"LOCKER18":
        raise ValueError("unsupported vault")
    length, = struct.unpack_from("<I", data, 8)
    if length > 4096 or len(data) < 12 + length + 16:
        raise ValueError("invalid header")
    aad = data[:12 + length]
    header = json.loads(data[12:12 + length])
    if header["version"] != 1:
        raise ValueError("unsupported version")
    key = hashlib.scrypt(phrase.encode("utf-8"), salt=bytes.fromhex(header["salt"]),
                         n=32768, r=8, p=1, dklen=32, maxmem=128*1024*1024)
    return AESGCM(key).decrypt(bytes.fromhex(header["nonce"]), data[12 + length:], aad)

if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("vault")
    args = p.parse_args()
    print(open_vault(args.vault, getpass.getpass("Recovery phrase: ")).decode("utf-8"))
