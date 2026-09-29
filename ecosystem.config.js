module.exports = {
  apps: [
    {
      name: 'monitor-backend',
      script: 'node',
      args: 'node_modules/ts-node/dist/bin.js packages/backend/src/index.ts',
      cwd: 'C:\\Projects\\Mutli-Account Balance & Transaction Monitoring System',
      interpreter: 'none',
      env: {
        PORT: 3001,
        TZ: 'Asia/Manila',
      },
      max_memory_restart: '256M',
      watch: false,
    },
  ],
};
