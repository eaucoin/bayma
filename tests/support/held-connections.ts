// The connections a Python session holds across a restore, as a session
// that talks to a server of its own and to one elsewhere does: one over
// loopback, both of its ends in the session, and one to a server outside
// the container bayma runs in, the echo server here, which the container
// reaches at its network's gateway. Asked afterwards, the session says of
// each whether it still answers ("open"), was closed ("closed"), or neither
// ("hung").

/** A server that echoes what each connection sends it, outside the container. */
export interface EchoServer {
  /** The address a container on Docker's default network reaches it at. */
  host: string;
  port: number;
  stop(): void;
}

export async function startEchoServer(): Promise<EchoServer> {
  const inspected = Bun.spawn(
    [
      "docker",
      "network",
      "inspect",
      "--format",
      "{{(index .IPAM.Config 0).Gateway}}",
      "bridge",
    ],
    { stdout: "pipe", stderr: "inherit" },
  );
  const host = (await new Response(inspected.stdout).text()).trim();
  if ((await inspected.exited) !== 0 || !host)
    throw new Error("Docker's default network names no gateway");
  const server = Bun.listen({
    hostname: "0.0.0.0",
    port: 0,
    socket: {
      data(socket, data) {
        socket.write(data);
      },
    },
  });
  return { host, port: server.port, stop: () => server.stop(true) };
}

/**
 * Python whose result says how the loopback connection is, then the outward
 * one, as a tuple: ('open', 'closed').
 */
export const PROBE_CONNECTIONS =
  "(held_answers(held_loopback, held_accepted), held_answers(held_outward, held_outward))";

/** Python that opens the connections, to `peer` the outward one, and probes them. */
export function holdConnections(peer: EchoServer): string {
  return [
    "import socket",
    'held_listener = socket.create_server(("127.0.0.1", 0))',
    "held_loopback = socket.create_connection(held_listener.getsockname())",
    "held_accepted, _ = held_listener.accept()",
    `held_outward = socket.create_connection((${JSON.stringify(peer.host)}, ${peer.port}))`,
    "def held_answers(sender, receiver):",
    "    sender.settimeout(10)",
    "    receiver.settimeout(10)",
    "    try:",
    '        sender.sendall(b"ping")',
    '        return "open" if receiver.recv(4) == b"ping" else "closed"',
    "    except TimeoutError:",
    '        return "hung"',
    "    except OSError:",
    '        return "closed"',
    PROBE_CONNECTIONS,
  ].join("\n");
}
