/**
 * Minimal DNS server for tests, so the "already delegated by someone else"
 * guard can be exercised without touching real registries.
 *
 * Answers NS queries from a fixed table and returns an empty answer for
 * everything else (which is how a public resolver behaves for an undelegated
 * name in practice). Listens on UDP on a high port; Node's Resolver accepts
 * `host:port` entries in setServers().
 *
 * Run: node scripts/stub-dns.mjs [port]
 */
import dgram from "node:dgram";

const port = Number(process.argv[2] ?? 35353);

/** name -> nameservers */
const DELEGATIONS = {
  "taken.verified.resukisu.org": ["ns1.someother.net", "ns2.someother.net"],
  "taken.contrib.resukisu.org": ["ns1.someother.net"],
};

function encodeName(name) {
  const parts = name.replace(/\.$/, "").split(".");
  const chunks = [];
  for (const part of parts) {
    const bytes = Buffer.from(part, "ascii");
    chunks.push(Buffer.from([bytes.length]), bytes);
  }
  chunks.push(Buffer.from([0]));
  return Buffer.concat(chunks);
}

function decodeName(buffer, offset) {
  const labels = [];
  let cursor = offset;
  // Pointers are not expected in the question section; bail out rather than loop.
  while (cursor < buffer.length) {
    const length = buffer[cursor];
    if (length === 0) {
      cursor += 1;
      break;
    }
    if ((length & 0xc0) === 0xc0) {
      cursor += 2;
      break;
    }
    labels.push(buffer.toString("ascii", cursor + 1, cursor + 1 + length));
    cursor += 1 + length;
  }
  return { name: labels.join("."), offset: cursor };
}

function buildRecord(name, nameserver) {
  const rdata = encodeName(nameserver);
  const header = Buffer.alloc(10);
  header.writeUInt16BE(2, 0); // NS
  header.writeUInt16BE(1, 2); // IN
  header.writeUInt32BE(300, 4); // TTL
  header.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([encodeName(name), header, rdata]);
}

const server = dgram.createSocket("udp4");

server.on("message", (message, remote) => {
  if (message.length < 12) {
    return;
  }

  const question = decodeName(message, 12);
  const qtype = message.readUInt16BE(question.offset);
  const queryEnd = question.offset + 4;

  const answers = [];
  if (qtype === 2 || qtype === 255) {
    for (const nameserver of DELEGATIONS[question.name.toLowerCase()] ?? []) {
      answers.push(buildRecord(question.name, nameserver));
    }
  }

  const header = Buffer.alloc(12);
  header.writeUInt16BE(message.readUInt16BE(0), 0); // id
  header.writeUInt16BE(0x8400, 2); // standard response, authoritative
  header.writeUInt16BE(1, 4); // qdcount
  header.writeUInt16BE(answers.length, 6); // ancount
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);

  const response = Buffer.concat([header, message.subarray(12, queryEnd), ...answers]);
  server.send(response, remote.port, remote.address);
});

server.bind(port, "127.0.0.1", () => {
  console.log(`stub dns listening on udp://127.0.0.1:${port}`);
  console.log(`delegations: ${Object.entries(DELEGATIONS).map(([name, ns]) => `${name} -> ${ns.join(",")}`).join("; ")}`);
});
