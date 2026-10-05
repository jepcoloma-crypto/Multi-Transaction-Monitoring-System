module.exports = {
  apps: [
    {
      name: 'monitor-backend',
      script: 'node',
      // Production serves the built output, not the working tree. Running
      // ts-node on packages/backend/src here meant every memory restart
      // shipped whatever was mid-edit; dist only changes on an explicit
      // `npm run build`, so a deploy is now a deliberate act.
      args: 'packages/backend/dist/index.js',
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
