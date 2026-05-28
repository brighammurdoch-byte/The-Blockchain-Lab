/**
 * PM2 Ecosystem File for Blockchain Lab
 * 
 * Usage:
 *   npm install -g pm2
 *   pm2 start ecosystem.config.js --env production
 *   pm2 save
 *   pm2 startup
 * 
 * Commands:
 *   pm2 logs blockchain-lab
 *   pm2 restart blockchain-lab
 *   pm2 stop blockchain-lab
 *   pm2 delete blockchain-lab
 */

module.exports = {
  apps: [
    {
      name: 'blockchain-lab',
      script: './bin/www',
      instances: 1, // Socket.io + in-memory state = single instance only
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'development',
        PORT: 3000
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000
        // Add any production secrets here
      },
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      // Auto restart on crashes
      autorestart: true,
      // Exponential backoff restart delay
      exp_backoff_restart_delay: 100,
      // Kill timeout for graceful shutdown
      kill_timeout: 5000
    }
  ]
};
