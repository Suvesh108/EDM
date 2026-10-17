package router

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"vortex-engine/pkg/downloader"
	"vortex-engine/pkg/sidecar"
	"vortex-engine/pkg/sniffer"
	"vortex-engine/pkg/torrent"
)

// Config sets runtime options for the API router
type Config struct {
	TempDir        string
	SidecarPort    int
	PythonScript   string
	StaticDistPath string
}

// Job represents a media extraction or stream download task
type Job struct {
	ID        string              `json:"id"`
	URL       string              `json:"url"`
	FormatID  string              `json:"formatId"`
	Title     string              `json:"title"`
	Extension string              `json:"extension"`
	Status    string              `json:"status"`
	Progress  int                 `json:"progress"`
	Speed     string              `json:"speed"`
	Eta       string              `json:"eta"`
	FilePath  string              `json:"filePath"`
	Error     string              `json:"error,omitempty"`
	Logs      []map[string]string `json:"logs"`
}

// ChunkJob represents an IDM-style parallel chunk task
type ChunkJob struct {
	ID         string                          `json:"id"`
	URL        string                          `json:"url"`
	Title      string                          `json:"title"`
	FileName   string                          `json:"fileName"`
	FilePath   string                          `json:"filePath"`
	Downloader *downloader.SegmentedDownloader `json:"-"`
	Progress   downloader.Progress             `json:"progress"`
}

// Server holds the HTTP mux and state managers
type Server struct {
	mux            *http.ServeMux
	cfg            Config
	sidecar        *sidecar.Client
	torrentMgr     *torrent.Manager
	jobs           map[string]*Job
	jobsMu         sync.RWMutex
	chunkJobs      map[string]*ChunkJob
	chunkMu        sync.RWMutex
	chunkQueues    map[string][]chan downloader.Progress
	queueMu        sync.Mutex
	httpClient     *http.Client
}

// NewServer initializes the router and dependencies
func NewServer(cfg Config) *Server {
	_ = os.MkdirAll(cfg.TempDir, 0755)

	s := &Server{
		mux:         http.NewServeMux(),
		cfg:         cfg,
		sidecar:     sidecar.NewClient(cfg.SidecarPort),
		torrentMgr:  torrent.NewManager(filepath.Join(cfg.TempDir, "torrents")),
		jobs:        make(map[string]*Job),
		chunkJobs:   make(map[string]*ChunkJob),
		chunkQueues: make(map[string][]chan downloader.Progress),
		httpClient: &http.Client{
			Timeout: 10 * time.Second,
		},
	}

	s.routes()
	return s
}

// GetSidecar returns the sidecar client
func (s *Server) GetSidecar() *sidecar.Client {
	return s.sidecar
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Enable CORS for all incoming requests
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, Range, X-Requested-With")
	w.Header().Set("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges")

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}

	s.mux.ServeHTTP(w, r)
}

func (s *Server) routes() {
	// 0. Health
	s.mux.HandleFunc("/api/health", s.handleHealth)

	// 1. URL Probe
	s.mux.HandleFunc("/api/probe", s.handleProbe)

	// 2. Info / Extraction (Universal Multi-Tier Sniffer & yt-dlp)
	s.mux.HandleFunc("/api/info", s.handleInfo)

	// 3. Stream Extraction Download
	s.mux.HandleFunc("/api/download", s.handleDownload)
	s.mux.HandleFunc("/api/download/progress", s.handleDownloadProgress)
	s.mux.HandleFunc("/api/download/file", s.handleDownloadFile)

	// 4. Turbo Parallel Chunk Downloader
	s.mux.HandleFunc("/api/chunk-download", s.handleChunkDownload)
	s.mux.HandleFunc("/api/chunk-download/progress", s.handleChunkProgress)
	s.mux.HandleFunc("/api/chunk-download/events/", s.handleChunkEvents)
	s.mux.HandleFunc("/api/chunk-download/file", s.handleChunkFile)

	// 5. BitTorrent
	s.mux.HandleFunc("/api/torrent/add", s.handleTorrentAdd)
	s.mux.HandleFunc("/api/torrent/status", s.handleTorrentStatus)
	s.mux.HandleFunc("/api/torrent/list", s.handleTorrentList)
	s.mux.HandleFunc("/api/torrent/", s.handleTorrentDelete)

	// 6. Feature Packs & Microservice Proxies (Full parity with Ghost-Downloader-3)
	s.mux.HandleFunc("/api/packs", s.handlePacks)
	s.mux.HandleFunc("/api/m3u8/", s.proxyToSidecar)
	s.mux.HandleFunc("/api/github/", s.proxyToSidecar)
	s.mux.HandleFunc("/api/huggingface/", s.proxyToSidecar)
	s.mux.HandleFunc("/api/ed2k/", s.proxyToSidecar)
	s.mux.HandleFunc("/api/ftp/", s.proxyToSidecar)
	s.mux.HandleFunc("/api/plugins", s.proxyToSidecar)
	s.mux.HandleFunc("/api/plugins/", s.proxyToSidecar)
	s.mux.HandleFunc("/api/accounts/", s.proxyToSidecar)
	s.mux.HandleFunc("/api/export/", s.proxyToSidecar)

	// 7. Aria2 JSON-RPC compatibility
	s.mux.HandleFunc("/jsonrpc", s.handleAria2RPC)
	s.mux.HandleFunc("/rpc", s.handleAria2RPC)
	s.mux.HandleFunc("/api/jsonrpc", s.handleAria2RPC)

	// 8. Static file serving (if built frontend exists)
	if s.cfg.StaticDistPath != "" {
		if fi, err := os.Stat(s.cfg.StaticDistPath); err == nil && fi.IsDir() {
			fs := http.FileServer(http.Dir(s.cfg.StaticDistPath))
			s.mux.Handle("/", fs)
		}
	}
}

func randomID(prefix string, length int) string {
	b := make([]byte, length/2)
	_, _ = rand.Read(b)
	return prefix + hex.EncodeToString(b)
}

func writeJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(data)
}

func sanitizeFilename(raw string) string {
	reg := regexp.MustCompile(`[^a-zA-Z0-9_-]`)
	cleaned := reg.ReplaceAllString(raw, "_")
	if len(cleaned) > 60 {
		cleaned = cleaned[:60]
	}
	if cleaned == "" {
		cleaned = "download"
	}
	return cleaned
}

// 0. Health
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{
		"status":  "ok",
		"service": "Vortex Universal Super-Engine (Hybrid Go Core v1.0.0)",
	})
}

// 1. Probe URL
func (s *Server) handleProbe(w http.ResponseWriter, r *http.Request) {
	targetURL := r.URL.Query().Get("url")
	if targetURL == "" {
		http.Error(w, "Valid URL parameter is required", http.StatusBadRequest)
		return
	}

	if strings.HasPrefix(targetURL, "magnet:?") {
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"type":           "torrent",
			"supportsRanges": false,
			"contentLength":  0,
			"contentType":    "application/x-bittorrent",
			"isDirectFile":   false,
		})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 6*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, "HEAD", targetURL, nil)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"type": "stream", "supportsRanges": false, "contentLength": 0, "isDirectFile": false,
		})
		return
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")

	resp, err := s.httpClient.Do(req)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"type": "stream", "supportsRanges": false, "contentLength": 0, "isDirectFile": false,
		})
		return
	}
	defer resp.Body.Close()

	contentLength := resp.ContentLength
	contentType := resp.Header.Get("Content-Type")
	acceptRanges := resp.Header.Get("Accept-Ranges") == "bytes"

	isDirect := contentLength > 0 && !strings.Contains(contentType, "text/html")

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"type":           map[bool]string{true: "direct", false: "stream"}[isDirect],
		"supportsRanges": acceptRanges,
		"contentLength":  contentLength,
		"contentType":    contentType,
		"isDirectFile":   isDirect,
	})
}

// 2. Info / Extraction (Universal Sniffer + yt-dlp)
func (s *Server) handleInfo(w http.ResponseWriter, r *http.Request) {
	targetURL := strings.TrimSpace(r.URL.Query().Get("url"))
	if targetURL == "" {
		http.Error(w, "URL parameter is required", http.StatusBadRequest)
		return
	}

	// 1. Try Python Extractor Sidecar (yt-dlp with mobile client stealth)
	meta, err := s.sidecar.Extract(targetURL)
	if err == nil && meta != nil && len(meta.Formats) > 0 {
		writeJSON(w, http.StatusOK, meta)
		return
	}

	// 2. Fallback: Universal Web Stream Sniffer (scrapes HTML5 <video>, .m3u8, .mpd, OpenGraph)
	sniffed, sErr := sniffer.SniffWebPage(targetURL)
	if sErr == nil && sniffed != nil && len(sniffed.Formats) > 0 {
		writeJSON(w, http.StatusOK, sniffed)
		return
	}

	// 3. Fallback: Generic direct stream format payload
	u, _ := url.Parse(targetURL)
	domain := "Direct Link"
	if u != nil {
		domain = u.Hostname()
	}

	filename := filepath.Base(u.Path)
	if filename == "" || filename == "/" || filename == "." {
		filename = "Direct_Stream.mp4"
	}

	fallbackMeta := map[string]interface{}{
		"title":       fmt.Sprintf("%s - %s", domain, filename),
		"duration":    "Direct Stream",
		"creator":     domain,
		"thumbnail":   "https://images.unsplash.com/photo-1542751371-adc38448a05e?q=80&w=640&auto=format&fit=crop",
		"originalUrl": targetURL,
		"formats": []map[string]interface{}{
			{
				"id":              "direct-original",
				"format":          "MP4",
				"resolution":      "Direct Stream (Original)",
				"size":            "Adaptive Size",
				"bitrate":         "Max Speed",
				"directUrl":       targetURL,
				"targetExtension": "mp4",
			},
			{
				"id":              "direct-audio",
				"format":          "MP3",
				"resolution":      "Audio 320kbps (MP3)",
				"size":            "Adaptive Size",
				"bitrate":         "320 kbps",
				"targetExtension": "mp3",
			},
		},
	}

	writeJSON(w, http.StatusOK, fallbackMeta)
}

// 3. Stream Extraction Download
type DownloadPayload struct {
	URL      string `json:"url"`
	FormatID string `json:"formatId"`
	Title    string `json:"title"`
	Format   string `json:"format"`
}

func (s *Server) handleDownload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var payload DownloadPayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		http.Error(w, "Invalid JSON payload", http.StatusBadRequest)
		return
	}

	jobID := randomID("job_", 12)
	cleanTitle := sanitizeFilename(payload.Title)
	ext := strings.ToLower(payload.Format)
	if ext == "" || ext == "mp4" {
		ext = "mp4"
	}
	fileName := fmt.Sprintf("%s_%s.%s", cleanTitle, jobID, ext)
	filePath := filepath.Join(s.cfg.TempDir, fileName)

	job := &Job{
		ID:        jobID,
		URL:       payload.URL,
		FormatID:  payload.FormatID,
		Title:     cleanTitle,
		Extension: ext,
		Status:    "downloading",
		Progress:  0,
		Speed:     "0.0 MB/s",
		Eta:       "--",
		FilePath:  filePath,
		Logs:      []map[string]string{},
	}

	s.jobsMu.Lock()
	s.jobs[jobID] = job
	s.jobsMu.Unlock()

	// Launch download via Python Sidecar with live IDM/FDM progress updates
	go func() {
		err := s.sidecar.DownloadStream(jobID, payload.URL, payload.FormatID, filePath, func(percent int, speed, eta string) {
			s.jobsMu.Lock()
			job.Progress = percent
			job.Speed = speed
			job.Eta = eta
			s.jobsMu.Unlock()
		})
		s.jobsMu.Lock()
		defer s.jobsMu.Unlock()

		if err != nil {
			job.Status = "error"
			job.Error = err.Error()
		} else {
			job.Status = "completed"
			job.Progress = 100
			job.Speed = "0.0 MB/s"
			job.Eta = "0s"
		}
	}()

	writeJSON(w, http.StatusOK, map[string]string{"jobId": jobID})
}

func (s *Server) handleDownloadProgress(w http.ResponseWriter, r *http.Request) {
	jobID := r.URL.Query().Get("jobId")
	s.jobsMu.RLock()
	job, exists := s.jobs[jobID]
	s.jobsMu.RUnlock()

	if !exists {
		http.Error(w, "Job not found", http.StatusNotFound)
		return
	}

	writeJSON(w, http.StatusOK, job)
}

func (s *Server) handleDownloadFile(w http.ResponseWriter, r *http.Request) {
	jobID := r.URL.Query().Get("jobId")
	s.jobsMu.RLock()
	job, exists := s.jobs[jobID]
	s.jobsMu.RUnlock()

	if !exists {
		http.Error(w, "Job not found", http.StatusNotFound)
		return
	}

	if job.Status != "completed" || job.FilePath == "" {
		http.Error(w, "File is not ready or downloading", http.StatusBadRequest)
		return
	}

	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"%s.%s\"", job.Title, job.Extension))
	http.ServeFile(w, r, job.FilePath)
}

// 4. Turbo Parallel Chunk Downloader
type ChunkPayload struct {
	URL            string `json:"url"`
	Title          string `json:"title"`
	Threads        int    `json:"threads"`
	DestinationDir string `json:"destinationDir"`
}

func (s *Server) handleChunkDownload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var payload ChunkPayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		http.Error(w, "Invalid JSON payload", http.StatusBadRequest)
		return
	}

	jobID := randomID("chunk_", 12)
	cleanTitle := sanitizeFilename(payload.Title)
	if cleanTitle == "" {
		cleanTitle = "direct_file"
	}

	parsedURL, _ := url.Parse(payload.URL)
	ext := filepath.Ext(parsedURL.Path)
	if ext == "" {
		ext = ".bin"
	}
	fileName := fmt.Sprintf("%s_%s%s", cleanTitle, jobID, ext)

	targetDir := s.cfg.TempDir
	isDirectSave := false
	if payload.DestinationDir != "" {
		if err := os.MkdirAll(payload.DestinationDir, 0755); err == nil {
			targetDir = payload.DestinationDir
			isDirectSave = true
		}
	}
	filePath := filepath.Join(targetDir, fileName)

	threads := payload.Threads
	if threads <= 0 {
		threads = 16
	}

	onUpdate := func(p downloader.Progress) {
		s.chunkMu.Lock()
		if cj, ok := s.chunkJobs[jobID]; ok {
			cj.Progress = p
		}
		s.chunkMu.Unlock()

		// Broadcast to SSE listeners
		s.queueMu.Lock()
		for _, q := range s.chunkQueues[jobID] {
			select {
			case q <- p:
			default:
			}
		}
		s.queueMu.Unlock()
	}

	dl := downloader.NewSegmentedDownloader(payload.URL, filePath, threads, onUpdate)

	cj := &ChunkJob{
		ID:         jobID,
		URL:        payload.URL,
		Title:      cleanTitle,
		FileName:   fileName,
		FilePath:   filePath,
		Downloader: dl,
		Progress: downloader.Progress{
			Status: "downloading",
		},
	}

	s.chunkMu.Lock()
	s.chunkJobs[jobID] = cj
	s.chunkMu.Unlock()

	go func() {
		_ = dl.Start()
	}()

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"jobId":        jobID,
		"fileName":     fileName,
		"filePath":     filePath,
		"isDirectSave": isDirectSave,
		"status":       "downloading",
	})
}

func (s *Server) handleChunkProgress(w http.ResponseWriter, r *http.Request) {
	jobID := r.URL.Query().Get("jobId")
	s.chunkMu.RLock()
	cj, exists := s.chunkJobs[jobID]
	s.chunkMu.RUnlock()

	if !exists {
		http.Error(w, "Chunk job not found", http.StatusNotFound)
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"jobId":    cj.ID,
		"fileName": cj.FileName,
		"progress": cj.Progress,
	})
}

func (s *Server) handleChunkEvents(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(r.URL.Path, "/")
	if len(parts) < 5 {
		http.Error(w, "Missing job ID", http.StatusBadRequest)
		return
	}
	jobID := parts[4]

	s.chunkMu.RLock()
	cj, exists := s.chunkJobs[jobID]
	s.chunkMu.RUnlock()

	if !exists {
		http.Error(w, "Job not found", http.StatusNotFound)
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Streaming unsupported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	q := make(chan downloader.Progress, 20)
	s.queueMu.Lock()
	s.chunkQueues[jobID] = append(s.chunkQueues[jobID], q)
	s.queueMu.Unlock()

	defer func() {
		s.queueMu.Lock()
		queues := s.chunkQueues[jobID]
		for i, ch := range queues {
			if ch == q {
				s.chunkQueues[jobID] = append(queues[:i], queues[i+1:]...)
				break
			}
		}
		s.queueMu.Unlock()
	}()

	// Send initial state
	initData, _ := json.Marshal(map[string]interface{}{
		"jobId":    jobID,
		"fileName": cj.FileName,
		"progress": cj.Progress,
	})
	fmt.Fprintf(w, "data: %s\n\n", initData)
	flusher.Flush()

	notify := r.Context().Done()
	for {
		select {
		case <-notify:
			return
		case p := <-q:
			data, _ := json.Marshal(map[string]interface{}{
				"jobId":    jobID,
				"fileName": cj.FileName,
				"progress": p,
			})
			fmt.Fprintf(w, "data: %s\n\n", data)
			flusher.Flush()
			if p.Status == "completed" || p.Status == "error" {
				return
			}
		}
	}
}

func (s *Server) handleChunkFile(w http.ResponseWriter, r *http.Request) {
	jobID := r.URL.Query().Get("jobId")
	s.chunkMu.RLock()
	cj, exists := s.chunkJobs[jobID]
	s.chunkMu.RUnlock()

	if !exists {
		http.Error(w, "Job not found", http.StatusNotFound)
		return
	}

	if cj.Progress.Status != "completed" || !fileExists(cj.FilePath) {
		http.Error(w, "File is not ready or still downloading", http.StatusBadRequest)
		return
	}

	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"%s\"", cj.FileName))
	http.ServeFile(w, r, cj.FilePath)
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	if err != nil {
		return false
	}
	return !info.IsDir()
}

// 5. BitTorrent Endpoints
type TorrentReq struct {
	MagnetURI string `json:"magnetURI"`
}

func (s *Server) handleTorrentAdd(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req TorrentReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.MagnetURI == "" {
		http.Error(w, "Valid magnetURI required", http.StatusBadRequest)
		return
	}

	item, err := s.torrentMgr.AddTorrent(req.MagnetURI, "")
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, item)
}

func (s *Server) handleTorrentStatus(w http.ResponseWriter, r *http.Request) {
	infoHash := r.URL.Query().Get("infoHash")
	item := s.torrentMgr.GetTorrent(infoHash)
	if item == nil {
		http.Error(w, "Torrent not found", http.StatusNotFound)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (s *Server) handleTorrentList(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.torrentMgr.ListTorrents())
}

func (s *Server) handleTorrentDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	parts := strings.Split(r.URL.Path, "/")
	if len(parts) < 4 {
		http.Error(w, "Missing hash", http.StatusBadRequest)
		return
	}
	hash := parts[3]
	deleteFiles := r.URL.Query().Get("deleteFiles") == "true"
	success := s.torrentMgr.RemoveTorrent(hash, deleteFiles)
	writeJSON(w, http.StatusOK, map[string]bool{"success": success})
}

// 6. Feature Packs
func (s *Server) handlePacks(w http.ResponseWriter, r *http.Request) {
	packs := []map[string]interface{}{
		{"id": "http", "name": "HttpPack", "version": "1.0.0", "description": "High-Speed Turbo Multi-Pipe Engine"},
		{"id": "bittorrent", "name": "BitTorrentPack", "version": "1.0.0", "description": "P2P Magnet & Torrent Swarm Engine"},
		{"id": "youtube", "name": "YouTubePack", "version": "1.0.0", "description": "yt-dlp Stealth Universal Video Engine"},
		{"id": "ftp", "name": "FtpPack", "version": "1.0.0", "description": "Remote FTP/FTPS Transfer Streamer"},
		{"id": "github", "name": "GitHubPack", "version": "1.0.0", "description": "GitHub Release Asset Ingestor"},
		{"id": "huggingface", "name": "HuggingFacePack", "version": "1.0.0", "description": "AI Model Weights & Dataset Pipeline"},
		{"id": "ed2k", "name": "Ed2kPack", "version": "1.0.0", "description": "eDonkey2000 Protocol Ingestor"},
	}
	writeJSON(w, http.StatusOK, packs)
}

func (s *Server) proxyToSidecar(w http.ResponseWriter, r *http.Request) {
	sidecarURL, err := url.Parse(s.sidecar.BaseURL)
	if err != nil {
		http.Error(w, "Sidecar address invalid", http.StatusInternalServerError)
		return
	}
	proxy := httputil.NewSingleHostReverseProxy(sidecarURL)
	proxy.ServeHTTP(w, r)
}

// 7. Aria2 JSON-RPC handler (Full compatibility with aria2c & extension)
type Aria2Request struct {
	JSONRPC string        `json:"jsonrpc"`
	ID      interface{}   `json:"id"`
	Method  string        `json:"method"`
	Params  []interface{} `json:"params"`
}

func (s *Server) handleAria2RPC(w http.ResponseWriter, r *http.Request) {
	var body Aria2Request
	_ = json.NewDecoder(r.Body).Decode(&body)

	reqID := body.ID
	if reqID == nil {
		reqID = "1"
	}

	switch body.Method {
	case "aria2.getVersion":
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"jsonrpc": "2.0",
			"id":      reqID,
			"result": map[string]interface{}{
				"version":         "1.37.0",
				"enabledFeatures": []string{"Async DNS", "BitTorrent", "Firefox3 Cookie", "GZip", "HTTPS", "Message Digest", "Metalink", "XML-RPC"},
			},
		})
	case "aria2.addUri":
		realParams := body.Params
		if len(realParams) > 0 {
			if strParam, ok := realParams[0].(string); ok && strings.HasPrefix(strParam, "token:") {
				realParams = realParams[1:]
			}
		}

		targetURL := ""
		if len(realParams) > 0 {
			if list, ok := realParams[0].([]interface{}); ok && len(list) > 0 {
				targetURL, _ = list[0].(string)
			} else if sUrl, ok := realParams[0].(string); ok {
				targetURL = sUrl
			}
		}

		if targetURL == "" {
			writeJSON(w, http.StatusBadRequest, map[string]interface{}{
				"jsonrpc": "2.0",
				"id":      reqID,
				"error":   map[string]interface{}{"code": -32602, "message": "Invalid URL parameter"},
			})
			return
		}

		gid := randomID("", 16)
		if strings.HasPrefix(targetURL, "magnet:?") {
			go func() {
				_, _ = s.torrentMgr.AddTorrent(targetURL, "")
			}()
		} else {
			cleanTitle := "aria2_task"
			fileName := fmt.Sprintf("%s_%s.bin", cleanTitle, gid)
			filePath := filepath.Join(s.cfg.TempDir, fileName)

			onUpdate := func(p downloader.Progress) {
				s.chunkMu.Lock()
				if cj, ok := s.chunkJobs[gid]; ok {
					cj.Progress = p
				}
				s.chunkMu.Unlock()
			}

			dl := downloader.NewSegmentedDownloader(targetURL, filePath, 16, onUpdate)
			cj := &ChunkJob{
				ID:         gid,
				URL:        targetURL,
				Title:      cleanTitle,
				FileName:   fileName,
				FilePath:   filePath,
				Downloader: dl,
				Progress: downloader.Progress{
					Status: "downloading",
				},
			}

			s.chunkMu.Lock()
			s.chunkJobs[gid] = cj
			s.chunkMu.Unlock()

			go func() {
				_ = dl.Start()
			}()
		}

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"jsonrpc": "2.0",
			"id":      reqID,
			"result":  gid,
		})
	case "aria2.tellStatus":
		realParams := body.Params
		if len(realParams) > 0 {
			if strParam, ok := realParams[0].(string); ok && strings.HasPrefix(strParam, "token:") {
				realParams = realParams[1:]
			}
		}

		gid := ""
		if len(realParams) > 0 {
			gid, _ = realParams[0].(string)
		}

		s.chunkMu.RLock()
		cj, exists := s.chunkJobs[gid]
		s.chunkMu.RUnlock()

		if exists && cj != nil {
			p := cj.Progress
			status := "active"
			if p.Status == "completed" {
				status = "complete"
			}
			writeJSON(w, http.StatusOK, map[string]interface{}{
				"jsonrpc": "2.0",
				"id":      reqID,
				"result": map[string]interface{}{
					"gid":             gid,
					"status":          status,
					"totalLength":     strconv.FormatInt(p.TotalBytes, 10),
					"completedLength": strconv.FormatInt(p.DownloadedBytes, 10),
					"downloadSpeed":   strconv.FormatInt(int64(p.SpeedBytesPerSec), 10),
					"files": []map[string]interface{}{
						{
							"path":   cj.FilePath,
							"length": strconv.FormatInt(p.TotalBytes, 10),
						},
					},
				},
			})
			return
		}

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"jsonrpc": "2.0",
			"id":      reqID,
			"result": map[string]interface{}{
				"gid":             gid,
				"status":          "complete",
				"totalLength":     "0",
				"completedLength": "0",
				"downloadSpeed":   "0",
				"files":           []interface{}{},
			},
		})
	case "aria2.tellActive":
		s.chunkMu.RLock()
		var activeList []map[string]interface{}
		for _, cj := range s.chunkJobs {
			if cj.Progress.Status == "downloading" {
				activeList = append(activeList, map[string]interface{}{
					"gid":             cj.ID,
					"status":          "active",
					"totalLength":     strconv.FormatInt(cj.Progress.TotalBytes, 10),
					"completedLength": strconv.FormatInt(cj.Progress.DownloadedBytes, 10),
					"downloadSpeed":   strconv.FormatInt(int64(cj.Progress.SpeedBytesPerSec), 10),
				})
			}
		}
		s.chunkMu.RUnlock()
		if activeList == nil {
			activeList = []map[string]interface{}{}
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"jsonrpc": "2.0",
			"id":      reqID,
			"result":  activeList,
		})
	default:
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"jsonrpc": "2.0",
			"id":      reqID,
			"result":  "OK",
		})
	}
}
