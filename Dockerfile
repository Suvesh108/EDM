# ==========================================
# Stage 1: Build the React frontend
# ==========================================
FROM node:22-slim AS builder
WORKDIR /app

# Copy dependency files
COPY package*.json ./

# Install all dependencies (required to run build script)
RUN npm ci

# Copy source code
COPY . .

# Build frontend (produces frontend/dist)
RUN npm run build

# ==========================================
# Stage 2: Final execution environment
# ==========================================
FROM python:3.11-slim
WORKDIR /app

# Set non-interactive timezone/frontend config
ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1

# Install system dependencies: ffmpeg and curl for healthchecks
RUN apt-get update && apt-get install -y \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements and install python packages
COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

# Copy backend source files
COPY backend ./backend

# Copy the built frontend bundle into backend/dist so FastAPI serves it
COPY --from=builder /app/frontend/dist ./backend/dist

# Expose backend port
EXPOSE 5001

# Environment variables
ENV NODE_ENV=production
ENV PORT=5001

# Run the backend server using Python / Uvicorn
CMD ["python", "backend/server.py"]
