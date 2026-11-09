// Bare-metal / VM deployment alternative to Docker.
// Usage:
//   npm install -g pm2
//   pm2 start ecosystem.config.js --env production
//   pm2 save && pm2 startup      (so it restarts on server reboot)
//   pm2 logs blue-pips           (tail logs)
//   pm2 reload blue-pips         (zero-downtime reload after a deploy)
module.exports = {
  apps: [
    {
      name: 'blue-pips',
      script: 'server/server.js',
      instances: 'max', // cluster mode across all CPU cores
      exec_mode: 'cluster',
      env_production: {
        NODE_ENV: 'production',
      },
      max_memory_restart: '300M',
      out_file: 'logs/out.log',
      error_file: 'logs/error.log',
      time: true,
    },
  ],
};
