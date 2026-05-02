/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverActions: true,
  },
  // Increase serverless function timeout for processing
  serverExternalPackages: ['pdf-parse', 'mammoth'],
};

module.exports = nextConfig;
