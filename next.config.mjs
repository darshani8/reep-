/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ['@prisma/client', '@anthropic-ai/sdk'],
};

export default nextConfig;
