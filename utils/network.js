const net = require("net");

// Development-only escape hatch so a local agent can register a loopback
// destination (TUNNEL_PROVIDER=direct). Never honoured in production.
const allowPrivateDestinations = () =>
  process.env.ALLOW_PRIVATE_DESTINATIONS === "true" &&
  process.env.NODE_ENV !== "production";

const isPrivateHostname = (rawHostname) => {
  const hostname = String(rawHostname || "").toLowerCase().replace(/^\[|\]$/g, "");

  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    return true;
  }

  if (net.isIP(hostname) === 4) {
    const [a, b, c] = hostname.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 192 && b === 0 && c === 0)
    );
  }

  if (net.isIP(hostname) === 6) {
    return (
      hostname === "::1" || hostname === "::" ||
      hostname.startsWith("fc") || hostname.startsWith("fd") ||
      /^fe[89ab]/.test(hostname) || hostname.startsWith("::ffff:")
    );
  }

  return false;
};

module.exports = { allowPrivateDestinations, isPrivateHostname };
