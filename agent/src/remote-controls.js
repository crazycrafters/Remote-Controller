// Commands are deliberately limited to the existing filesystem and process APIs.
export async function executeCommand(agent, command) {
  const args = command.args || {};
  switch (command.operation) {
    case 'roots': return agent.roots();
    case 'files': return agent.browse(args.path || '');
    case 'applications': return { applications: await agent.applications() };
    case 'close': {
      if (typeof args.ticket !== 'string' || typeof args.force !== 'boolean' || (args.force && args.confirm !== 'FORCE')) throw Object.assign(new Error('Invalid close request or missing force confirmation'), { status: 400 });
      await agent.stop(args.ticket, args.force);
      return { status: 'close-requested' };
    }
    case 'download': {
      const result = await agent.download(args.path || '');
      try {
        // Bound memory in this JSON-based MVP transport, including files that grow during reading.
        const max = 8 * 1024 * 1024;
        if (result.size > max) throw Object.assign(new Error('Central downloads are limited to 8 MiB per file'), { status: 413 });
        const data = Buffer.alloc(Math.min(result.size + 1, max + 1));
        let total = 0;
        while (total < data.length) {
          const { bytesRead } = await result.file.read(data, total, data.length - total, null);
          if (!bytesRead) break;
          total += bytesRead;
        }
        if (total > result.size) throw Object.assign(new Error('File changed during download; retry'), { status: 409 });
        return { name: result.name, data: data.subarray(0, total).toString('base64') };
      } finally { await result.file.close(); }
    }
    default: throw Object.assign(new Error('Unsupported operation'), { status: 400 });
  }
}
