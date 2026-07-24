"""CLI entry point: python -m qa_agent_runner [server|replay]."""

import sys


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: python -m qa_agent_runner [server|replay] ...", file=sys.stderr)
        sys.exit(1)

    mode = sys.argv[1]

    if mode == "server":
        from qa_agent_runner.server import run_server

        run_server()
    elif mode == "replay":
        if len(sys.argv) < 3:
            print("Usage: python -m qa_agent_runner replay <steps.json>", file=sys.stderr)
            sys.exit(1)
        from qa_agent_runner.replay import run_replay

        run_replay(sys.argv[2])
    else:
        print(f"Unknown mode: {mode}. Use 'server' or 'replay'.", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
