# --- Stage 1: Build ---
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files first to leverage Docker layer caching
COPY package*.json ./

# Install all dependencies (including devDependencies for tsc)
RUN npm install

# Copy the rest of your source code
COPY . .

# Run the build script (runs 'tsc' as per your package.json)
RUN npm run build


# --- Stage 2: Production ---
FROM node:20-alpine AS runner

WORKDIR /app

# Set environment to production
ENV NODE_ENV=production

# Copy package files
COPY package*.json ./

# Install ONLY production dependencies
RUN npm ci --omit=dev

# Copy the compiled code from the builder stage
COPY --from=builder /app/dist ./dist

# If you have static files or templates (like your 'hbs' dependency suggests), 
# ensure they are copied as well if they aren't in the dist folder:
COPY --from=builder /app/assets ./assets
COPY --from=builder /app/templates ./templates

# Expose the port your Express app runs on (update if different)
EXPOSE 3000

# Start the application
CMD ["npm", "start"]