const exitCode = Number.parseInt(process.argv[2] ?? '0', 10);

process.exit(Number.isNaN(exitCode) ? 1 : exitCode);
