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
        // The startup guard only refuses to run when it knows it is in
        // production (services/configGuard.ts), and dotenv never overwrites
        // what pm2 already set — so this line is what switches it on. Deploy
        // with `pm2 restart monitor-backend --update-env`: without that flag
        // the running process keeps the environment it was started with.
        NODE_ENV: 'production',
      },
      max_memory_restart: '256M',
      watch: false,
    },
  ],
};
