# Use the official Microsoft Playwright image (includes all browser dependencies)
FROM mcr.microsoft.com/playwright:v1.40.0-jammy

# Set working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy your backend code
COPY . .

# Expose port 4000
EXPOSE 4000

# Start the server
CMD ["node", "index.js"]