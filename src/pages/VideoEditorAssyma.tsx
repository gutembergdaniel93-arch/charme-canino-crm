import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  Video, Play, RefreshCw, Trash2, Power, Terminal,
  Plus, Upload, GripVertical, FolderOpen, Eye, X, FileVideo, CheckCircle2,
  Clock, ArrowUpDown, Search, Sparkles, ImageIcon, Download, ChevronDown, ChevronUp
} from 'lucide-react';

const API = 'http://localhost:3001';

export default function VideoEditorSection({ autoIncludeVideo = '' } = {}) {
  const [serverActive, setServerActive] = useState(false);
  const [port, setPort] = useState(4820);

  // Projetos: cada um é uma pasta isolada (server.js resolve por id via
  // resolveProjectDir) — `workspace` abaixo é só a pasta do projeto ATUAL,
  // derivada da lista, não um estado próprio. Isso mantém intacto todo o
  // código existente que já monta caminhos com `${workspace}\...`.
  const [projects, setProjects] = useState([]);
  const [currentProjectId, setCurrentProjectId] = useState(null);
  const [projectSearch, setProjectSearch] = useState('');
  const [loadingProjects, setLoadingProjects] = useState(false);
  const currentProject = projects.find(p => p.id === currentProjectId) || null;
  const workspace = currentProject ? currentProject.dir : '';

  const [videoFiles, setVideoFiles] = useState([]);
  const [loadingVideos, setLoadingVideos] = useState(false);
  const [logs, setLogs] = useState(['[Assyma OS] Inicializando módulo de edição de vídeo...']);
  const [runningCmd, setRunningCmd] = useState(false);

  // Sorting & Filtering
  const [categoryFilter, setCategoryFilter] = useState('all'); // 'all', 'raw', 'exported'
  const [sortBy, setSortBy] = useState('date'); // 'date', 'name'

  // Export & preview states
  const [lastExportedPath, setLastExportedPath] = useState(null);
  const [previewModalVideo, setPreviewModalVideo] = useState(null);

  // Upload states
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const fileInputRef = useRef(null);

  // Selection & drag-reorder
  const [selectedVideos, setSelectedVideos] = useState([]);
  const [processedVideos, setProcessedVideos] = useState(new Set());
  const [dragOverIdx, setDragOverIdx] = useState(null);
  const dragSrcIdx = useRef(null);

  // Rubber-band selection state
  const listRef = useRef(null);
  const itemRefs = useRef([]);
  const [rubberBand, setRubberBand] = useState(null); // {x,y,w,h} in list coords
  const rbStart = useRef(null); // {x,y,scrollTop} at mousedown
  const isRubberBanding = useRef(false);

  const logsEndRef = useRef(null);
  const remoteLogRef = useRef('');
  const autoIncludeTriggered = useRef(false); // evita disparar handleIncluirVideo mais de uma vez

  // B-Roll panel state
  const [brollOpen, setBrollOpen] = useState(false);
  const [brollQuery, setBrollQuery] = useState('');
  const [brollSource, setBrollSource] = useState('pexels'); // 'pexels' | 'gpt'
  const [brollResults, setBrollResults] = useState([]);
  const [brollLoading, setBrollLoading] = useState(false);
  const [brollError, setBrollError] = useState(null);
  const [brollGptPrompt, setBrollGptPrompt] = useState('');
  const [savedBrolls, setSavedBrolls] = useState([]);

  useEffect(() => {
    loadProjects();
  }, []);

  // Uma vez que os projetos chegam (ou o projeto ativo muda), recarrega tudo
  // que depende de qual pasta está selecionada.
  useEffect(() => {
    if (!currentProjectId) return;
    checkServerStatus();
    loadVideos();
  }, [currentProjectId]);

  // O render automático acontece no watcher do servidor principal (fora do
  // iframe). Espelhamos seu log aqui para o usuário acompanhar o trabalho
  // depois de clicar em “Salvar e aplicar estilo”.
  useEffect(() => {
    if (!currentProjectId) return undefined;
    remoteLogRef.current = '';
    const syncRenderLog = async () => {
      try {
        const res = await fetch(`${API}/api/assyma-studio/render-log?projectId=${encodeURIComponent(currentProjectId)}`);
        if (!res.ok) return;
        const data = await res.json();
        const lines = Array.isArray(data.lines) ? data.lines : [];
        const signature = lines.join('\n');
        if (!signature || signature === remoteLogRef.current) return;
        remoteLogRef.current = signature;
        setLogs(prev => {
          const existing = new Set(prev);
          const incoming = lines.filter(line => !existing.has(line));
          return incoming.length ? [...prev, ...incoming] : prev;
        });
      } catch (_) { /* preview pode estar desligado durante a troca de projeto */ }
    };
    syncRenderLog();
    const timer = setInterval(syncRenderLog, 2000);
    return () => clearInterval(timer);
  }, [currentProjectId]);

  useEffect(() => {
    if (logsEndRef.current) logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const addLog = (text) =>
    setLogs(prev => [...prev, `${new Date().toLocaleTimeString('pt-BR')} ${text}`]);

  const loadProjects = async () => {
    setLoadingProjects(true);
    try {
      const res = await fetch(`${API}/api/assyma-studio/projects`);
      const data = await res.json();
      const list = data.projects || [];
      setProjects(list);
      if (!currentProjectId && list.length > 0) {
        // Favorito mais recente primeiro, senão o mais recém-atualizado.
        const sorted = [...list].sort((a, b) => {
          if (!!b.favorite !== !!a.favorite) return (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0);
          return new Date(b.updatedAt) - new Date(a.updatedAt);
        });
        setCurrentProjectId(sorted[0].id);
      }
    } catch (e) {
      addLog('[Erro] Falha ao carregar a lista de projetos.');
    } finally {
      setLoadingProjects(false);
    }
  };

  const handleSelectProject = (id) => {
    if (id === currentProjectId) return;
    setCurrentProjectId(id);
    // Estado da timeline/lista pertence ao projeto anterior — limpa antes do
    // próximo useEffect recarregar tudo pro projeto novo.
    setVideoFiles([]);
    setSelectedVideos([]);
    setProcessedVideos(new Set());
    setLastExportedPath(null);
  };

  const handleCreateProject = async () => {
    const name = window.prompt('Nome do novo projeto:');
    if (!name || !name.trim()) return;
    try {
      const res = await fetch(`${API}/api/assyma-studio/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      const data = await res.json();
      if (data.ok) {
        setProjects(prev => [...prev, data.project]);
        handleSelectProject(data.project.id);
        addLog(`[Projetos] "${data.project.name}" criado.`);
      } else {
        addLog('[Erro] Falha ao criar projeto.');
      }
    } catch (e) {
      addLog('[Erro] Falha ao criar projeto.');
    }
  };

  const handleToggleFavorite = async (id, e) => {
    e.stopPropagation();
    const project = projects.find(p => p.id === id);
    if (!project) return;
    const favorite = !project.favorite;
    setProjects(prev => prev.map(p => (p.id === id ? { ...p, favorite } : p)));
    try {
      await fetch(`${API}/api/assyma-studio/projects/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ favorite }),
      });
    } catch (e2) { /* já refletido otimisticamente; próxima loadProjects corrige se falhar */ }
  };

  const handleOpenFileLocation = async (filePath) => {
    if (!filePath) return;
    addLog(`[Local] Caminho do arquivo: ${filePath}`);
    console.log('[Local do Arquivo]', filePath);
    try {
      const res = await fetch(`${API}/api/assyma-studio/open-file-location`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath })
      });
      const data = await res.json();
      if (data.ok) {
        addLog(`[Explorer] Pasta aberta com o arquivo selecionado.`);
      } else {
        addLog(`[Erro] Falha ao abrir pasta: ${data.error}`);
      }
    } catch (e) {
      addLog(`[Erro] Falha na comunicação com o servidor ao abrir pasta.`);
    }
  };

  const handleViewVideo = async (filePath, name = '') => {
    if (!filePath) return;
    const displayName = name || filePath.split('\\').pop();
    addLog(`[Vídeo] Caminho completo do vídeo: ${filePath}`);
    console.log('[Ver Vídeo - Caminho]', filePath);
    
    setPreviewModalVideo({ path: filePath, name: displayName });
    
    try {
      const res = await fetch(`${API}/api/assyma-studio/open-file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath })
      });
      const data = await res.json();
      if (data.ok) {
        addLog(`[Player] Vídeo aberto no player do sistema.`);
      }
    } catch (_) {}
  };

  const checkServerStatus = async () => {
    try {
      const res = await fetch(`${API}/api/assyma-studio/status`);
      const data = await res.json();
      // O servidor de preview é um só pro sistema inteiro — só conta como
      // "ativo" pra este painel se estiver apontando pro projeto selecionado
      // aqui agora (pode estar rodando pra OUTRO projeto).
      setServerActive(!!data.active && data.projectId === currentProjectId);
      setPort(data.port);
    } catch (_) {}
  };

  const loadVideos = async () => {
    if (!currentProjectId) return;
    setLoadingVideos(true);
    try {
      const res = await fetch(`${API}/api/assyma-studio/list-videos?projectId=${encodeURIComponent(currentProjectId)}`);
      const data = await res.json();
      setVideoFiles(data.files || []);
    } catch (_) {}
    setLoadingVideos(false);
  };

  const handleStartServer = async () => {
    if (!currentProjectId) return;
    addLog('[Assyma Server] Iniciando servidor de preview...');
    try {
      const res = await fetch(`${API}/api/assyma-studio/start-server`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: currentProjectId }),
      });
      const data = await res.json();
      if (data.ok) {
        setServerActive(true);
        addLog('[Assyma Server] Servidor ativo e escutando na porta ' + data.port);
      } else {
        addLog('[Erro] Falha ao ligar o servidor: ' + data.error);
      }
    } catch (e) {
      addLog('[Erro] Servidor indisponível.');
    }
  };

  const handleStopServer = async () => {
    addLog('[Assyma Server] Desligando servidor de preview...');
    try {
      const res = await fetch(`${API}/api/assyma-studio/stop-server`, { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        setServerActive(false);
        addLog('[Assyma Server] Servidor desligado com sucesso.');
      }
    } catch (e) {
      addLog('[Erro] Erro ao desligar o servidor.');
    }
  };

  const handleRunHelper = async (scriptName, args = []) => {
    setRunningCmd(true);
    addLog(`[Assyma Cmd] Executando script: ${scriptName} com argumentos: ${args.join(' ')}...`);
    try {
      const res = await fetch(`${API}/api/assyma-studio/run-command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scriptName, args })
      });
      const data = await res.json();
      if (data.ok) {
        addLog(`[Assyma Cmd] Sucesso! Código de saída 0.`);
        if (data.stdout) addLog(`[Stdout]: ${data.stdout}`);
      } else {
        addLog(`[Assyma Cmd] Falha! Código de saída ${data.code}`);
        if (data.stderr) addLog(`[Stderr]: ${data.stderr}`);
      }
    } catch (e) {
      addLog('[Erro] Conexão com o script falhou.');
    } finally {
      setRunningCmd(false);
    }
  };

  const handleDeleteSelected = async () => {
    if (selectedVideos.length === 0) return;
    if (!window.confirm(`Apagar ${selectedVideos.length} vídeo(s)? Essa ação não pode ser desfeita.`)) return;
    let deleted = 0;
    for (const name of selectedVideos) {
      try {
        const res = await fetch(`${API}/api/assyma-studio/delete-video`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: name, projectId: currentProjectId })
        });
        if (res.ok) { deleted++; addLog(`[Delete] ${name} removido.`); }
        else {
          const detail = await res.json().catch(() => ({}));
          addLog(`[Erro] Falha ao remover ${name}: ${detail.error || `HTTP ${res.status}`}`);
        }
      } catch { addLog(`[Erro] Falha ao remover ${name}.`); }
    }
    setSelectedVideos([]);
    addLog(`[Delete] ${deleted} arquivo(s) removido(s).`);
    loadVideos();
  };

  const handleDeleteIndividual = async (name) => {
    try {
      const res = await fetch(`${API}/api/assyma-studio/delete-video`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: name, projectId: currentProjectId })
      });
      if (res.ok) {
        addLog(`[Delete] ${name} removido.`);
        setSelectedVideos(prev => prev.filter(x => x !== name));
        loadVideos();
      } else {
        const detail = await res.json().catch(() => ({}));
        addLog(`[Erro] Falha ao remover ${name}: ${detail.error || `HTTP ${res.status}`}`);
      }
    } catch {
      addLog(`[Erro] Falha ao remover ${name}.`);
    }
  };

  const sortedAndFilteredFiles = useMemo(() => {
    let result = [...videoFiles];
    
    // Sort logic
    if (sortBy === 'date') {
      result.sort((a, b) => {
        const timeA = new Date(a.modifiedAt || a.createdAt).getTime();
        const timeB = new Date(b.modifiedAt || b.createdAt).getTime();
        return timeB - timeA; // newest first
      });
    } else {
      result.sort((a, b) => a.name.localeCompare(b.name));
    }
    
    // Filter logic
    if (categoryFilter === 'raw') {
      result = result.filter(f => !f.name.startsWith('corte_preview_') && !f.name.startsWith('corte_final_'));
    } else if (categoryFilter === 'exported') {
      result = result.filter(f => f.name.startsWith('corte_preview_') || f.name.startsWith('corte_final_'));
    }
    
    return result;
  }, [videoFiles, sortBy, categoryFilter]);

  // ── B-Roll handlers ──────────────────────────────────────────────────────
  const handleBrollSearch = async () => {
    if (!brollQuery.trim()) return;
    setBrollLoading(true);
    setBrollError(null);
    setBrollResults([]);
    try {
      const res = await fetch(`${API}/api/images/search?q=${encodeURIComponent(brollQuery)}&source=pexels&per_page=12`);
      const data = await res.json();
      if (data.warning) { setBrollError(data.warning); return; }
      setBrollResults(data.images || []);
      if (!data.images?.length) setBrollError('Nenhuma imagem encontrada. Tente outro termo.');
    } catch (e) {
      setBrollError('Erro ao buscar imagens no Pexels.');
    } finally {
      setBrollLoading(false);
    }
  };

  const handleBrollGenerate = async () => {
    const prompt = brollGptPrompt.trim() || brollQuery.trim();
    if (!prompt) return;
    setBrollLoading(true);
    setBrollError(null);
    setBrollResults([]);
    addLog(`[B-Roll IA] Gerando imagem: "${prompt}"...`);
    try {
      const res = await fetch(`${API}/api/ai/generate-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: `Cinematic vertical portrait B-roll image for social media video: ${prompt}. Professional, high quality, no text, no watermarks.` })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Falha ao gerar imagem');
      setBrollResults([{ id: `gpt-${Date.now()}`, url: data.dataUrl || data.url, thumb: data.dataUrl || data.url, author: 'GPT-Image', source: 'gpt' }]);
      addLog(`[B-Roll IA] ✅ Imagem gerada com sucesso!`);
    } catch (e) {
      setBrollError(`Erro ao gerar imagem: ${e.message}`);
      addLog(`[B-Roll IA] ❌ ${e.message}`);
    } finally {
      setBrollLoading(false);
    }
  };

  const handleSaveBrollToProject = async (img) => {
    const remotionPublic = `${workspace}\\edit\\remotion\\public\\pexels`;
    addLog(`[B-Roll] Salvando imagem no projeto: ${img.url?.slice(0, 60)}...`);
    try {
      const res = await fetch(`${API}/api/assyma-studio/save-broll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: img.url, outDir: remotionPublic, source: img.source })
      });
      const data = await res.json();
      if (data.ok) {
        addLog(`[B-Roll] ✅ Salvo em: ${data.filename}`);
        setSavedBrolls(prev => [...prev, { ...img, localPath: data.filename, remotionSrc: `pexels/${data.filename}` }]);
      } else {
        addLog(`[B-Roll] ❌ Falha: ${data.error}`);
      }
    } catch (e) {
      addLog(`[B-Roll] ❌ Erro de conexão: ${e.message}`);
    }
  };

  // De volta ao jeito antigo: "Incluir" sempre inclui na sequência normal do
  // corte, sem perguntar nada — o fluxo de "camada nova" (tela dividida com
  // vídeo de fundo) foi removido daqui por pedido explícito. A tela dividida
  // com vídeo continua existindo como opção manual na coluna Estilo (aba
  // Layout, fonte de B-Roll "Meu vídeo"), só não tem mais esse atalho aqui.
  const handleIncluirVideo = async (videoName) => {
    if (processedVideos.has(videoName)) {
      addLog(`[Corte Automático] ${videoName} já foi processado antes — usando corte em cache.`);
      if (serverActive) { setServerActive(false); setTimeout(() => setServerActive(true), 500); }
      else handleStartServer();
      return;
    }
    setRunningCmd(true);
    addLog(`[Corte Automático] Processando ${videoName}: detectando silêncios e gerando corte...`);
    const args = [`${workspace}\\${videoName}`, '--edit-dir', `${workspace}\\edit`, '--append'];
    try {
      const res = await fetch(`${API}/api/assyma-studio/run-command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scriptName: 'assyma_corte.py', args })
      });
      const data = await res.json();
      if (data.ok) {
        setProcessedVideos(prev => new Set([...prev, videoName]));
        addLog(`[Corte Automático] ${videoName} processado e incluído! Corte salvo em cache.`);
        if (data.stdout) addLog(`[Stdout]: ${data.stdout}`);
        if (serverActive) { setServerActive(false); setTimeout(() => setServerActive(true), 500); }
        else handleStartServer();
      } else {
        addLog(`[Corte Automático] Falha ao processar ${videoName}.`);
        if (data.stderr) addLog(`[Stderr]: ${data.stderr.slice(0, 200)}`);
      }
    } catch (e) {
      addLog(`[Erro] Comunicação falhou para ${videoName}.`);
    } finally {
      setRunningCmd(false);
    }
  };

  // Continuação vinda de outra ferramenta (ex.: Viral Clipping "Enviar para
  // Assyma Studio") — assim que o vídeo indicado aparecer na lista do
  // workspace, inclui e processa automaticamente, sem precisar clicar de novo.
  useEffect(() => {
    if (!autoIncludeVideo || autoIncludeTriggered.current) return;
    const existe = videoFiles.some((v) => v.name === autoIncludeVideo);
    if (existe) {
      autoIncludeTriggered.current = true;
      addLog(`[Continuação] Vídeo recebido de outra ferramenta: ${autoIncludeVideo}`);
      handleIncluirVideo(autoIncludeVideo);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoIncludeVideo, videoFiles]);

  const handleAutoEdl = async () => {
    if (selectedVideos.length === 0) return;
    setRunningCmd(true);
    addLog(`[Corte Automático] Iniciando Corte Seco Inteligente para: ${selectedVideos.join(', ')}...`);
    const videoPaths = selectedVideos.map(name => `${workspace}\\${name}`);
    const args = [...videoPaths, '--edit-dir', `${workspace}\\edit`];
    try {
      const res = await fetch(`${API}/api/assyma-studio/run-command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scriptName: 'assyma_corte.py', args })
      });
      const data = await res.json();
      if (data.ok) {
        selectedVideos.forEach(n => setProcessedVideos(prev => new Set([...prev, n])));
        addLog(`[Corte Automático] Corte seco criado com sucesso!`);
        if (data.stdout) addLog(`[Stdout]: ${data.stdout}`);
        if (serverActive) { setServerActive(false); setTimeout(() => setServerActive(true), 500); }
        else handleStartServer();
      } else {
        addLog(`[Corte Automático] Falha ao processar vídeo(s).`);
        if (data.stderr) addLog(`[Stderr]: ${data.stderr}`);
      }
    } catch (e) {
      addLog('[Erro] Comunicação com o script de Corte Seco falhou.');
    } finally {
      setRunningCmd(false);
    }
  };

  const handleClearTimeline = async () => {
    if (!window.confirm('Limpar toda a timeline? Os arquivos de corte serão apagados. Os vídeos originais não serão afetados.')) return;
    addLog('[Timeline] Limpando projeto de corte...');
    try {
      const res = await fetch(`${API}/api/assyma-studio/clear-timeline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: currentProjectId }),
      });
      const data = await res.json();
      if (data.ok) {
        addLog(`[Timeline] Limpa! ${data.removed} arquivo(s) removido(s).`);
        setProcessedVideos(new Set());
        setLastExportedPath(null);
        if (serverActive) { setServerActive(false); setTimeout(() => setServerActive(true), 800); }
      } else {
        addLog(`[Erro] Falha ao limpar: ${data.error}`);
      }
    } catch (e) {
      addLog('[Erro] Falha ao comunicar com o servidor.');
    }
  };

  const handleRender = async (quality = 'preview') => {
    setRunningCmd(true);
    const now = new Date().toISOString().replace(/[:.]/g, '-').slice(0,19);
    const outPath = `${workspace}\\corte_${quality}_${now}.mp4`;
    addLog(`[Render] Iniciando render ${quality.toUpperCase()}...`);
    addLog(`[Render] Saída: ${outPath}`);
    try {
      const res = await fetch(`${API}/api/assyma-studio/render-video`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quality, projectId: currentProjectId, outPath })
      });
      const data = await res.json();
      if (data.ok) {
        setLastExportedPath(outPath);
        addLog(`[Render] ✅ Vídeo gerado com sucesso!`);
        addLog(`[Render] Arquivo exportado: ${outPath}`);
        console.log('[Render Exportado]', outPath);
        if (data.stdout) addLog(`[Stdout]: ${data.stdout}`);
      } else {
        addLog(`[Render] ❌ Falha no render.`);
        if (data.stderr) addLog(`[Stderr]: ${data.stderr}`);
      }
    } catch (e) {
      addLog('[Erro] Conexão com o servidor de render falhou.');
    } finally {
      setRunningCmd(false);
    }
  };

  const handleFileUpload = async (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    if (!currentProjectId) { addLog('[Erro] Selecione um projeto antes de enviar vídeos.'); return; }
    setUploading(true);
    setUploadProgress(0);
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      addLog(`[Upload] Enviando arquivo ${i + 1} de ${files.length}: ${file.name}...`);
      const formData = new FormData();
      formData.append('video', file);
      await new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        // projectId vai na query string, não no FormData — a rota de upload
        // resolve o destino no callback do multer, antes do corpo multipart
        // terminar de chegar (ver comentário em server.js).
        xhr.open('POST', `${API}/api/assyma-studio/upload?projectId=${encodeURIComponent(currentProjectId)}`, true);
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            const percent = Math.round((event.loaded / event.total) * 100);
            setUploadProgress(Math.round(((i + percent / 100) / files.length) * 100));
          }
        };
        xhr.onload = () => {
          if (xhr.status === 200) addLog(`[Upload] Sucesso! ${file.name} salvo.`);
          else addLog(`[Erro] Falha no upload de ${file.name}.`);
          resolve();
        };
        xhr.onerror = () => { addLog(`[Erro] Conexão interrompida no upload de ${file.name}.`); resolve(); };
        xhr.send(formData);
      });
    }
    setUploading(false);
    addLog(`[Upload] Todos os ${files.length} arquivos foram processados!`);
    loadVideos();
  };

  // ── Rubber-band selection ──────────────────────────────────────────────────
  const getListRect = () => listRef.current?.getBoundingClientRect();

  const onListMouseDown = (e) => {
    // Only start rubber-band if clicking on the list background (not on a child item)
    if (e.target !== listRef.current) return;
    e.preventDefault();
    const rect = getListRect();
    const scrollTop = listRef.current.scrollTop;
    rbStart.current = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top + scrollTop,
      clientY0: e.clientY,
    };
    isRubberBanding.current = true;
    setRubberBand({ x: rbStart.current.x, y: rbStart.current.y - scrollTop, w: 0, h: 0 });
  };

  const onListMouseMove = useCallback((e) => {
    if (!isRubberBanding.current || !rbStart.current || !listRef.current) return;
    const rect = getListRect();
    const scrollTop = listRef.current.scrollTop;
    const curX = e.clientX - rect.left;
    const curY = e.clientY - rect.top + scrollTop;

    const x = Math.min(rbStart.current.x, curX);
    const y = Math.min(rbStart.current.y, curY);
    const w = Math.abs(curX - rbStart.current.x);
    const h = Math.abs(curY - rbStart.current.y);

    setRubberBand({ x, y: y - scrollTop, w, h });

    // Check intersection with each item
    const rbTop = y;
    const rbBottom = y + h;
    const newSelected = [];
    itemRefs.current.forEach((el, idx) => {
      if (!el) return;
      const elRect = el.getBoundingClientRect();
      const elTop = elRect.top - rect.top + scrollTop;
      const elBottom = elRect.bottom - rect.top + scrollTop;
      if (elBottom >= rbTop && elTop <= rbBottom) {
        newSelected.push(videoFiles[idx]?.name);
      }
    });
    setSelectedVideos(newSelected.filter(Boolean));
  }, [videoFiles]);

  const onListMouseUp = useCallback(() => {
    isRubberBanding.current = false;
    rbStart.current = null;
    setRubberBand(null);
  }, []);

  useEffect(() => {
    window.addEventListener('mousemove', onListMouseMove);
    window.addEventListener('mouseup', onListMouseUp);
    return () => {
      window.removeEventListener('mousemove', onListMouseMove);
      window.removeEventListener('mouseup', onListMouseUp);
    };
  }, [onListMouseMove, onListMouseUp]);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: 16, height: 'calc(100vh - 120px)', minHeight: 650 }}>

      {/* ── Coluna Esquerda: Workspace ── */}
      <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14, overflowY: 'auto' }}>
        <div>
          <h3 style={{ fontSize: 15, fontWeight: 800, color: 'var(--text-1)', margin: '0 0 2px 0', display: 'flex', alignItems: 'center', gap: 7, letterSpacing: 0.3 }}>
            <img src="/assymaLogo.png" alt="Assyma" style={{ height: 22, objectFit: 'contain', filter: 'brightness(1.1)' }} /> ASSYMA STUDIO
          </h3>
          <p style={{ fontSize: 10, color: 'var(--text-3)', margin: 0 }}>Pasta para matérias brutas e projetos</p>
        </div>

        {/* Projetos — cada um é uma pasta isolada agora (antes era um workspace
            único reciclado a cada corte, "baixamos e já era"). */}
        <div style={{ borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
              Projetos ({projects.length})
            </span>
            <button
              onClick={handleCreateProject}
              style={{
                display: 'flex', alignItems: 'center', gap: 3, padding: '3px 7px', fontSize: 9.5, fontWeight: 800,
                borderRadius: 6, cursor: 'pointer', background: 'rgba(201,168,76,0.12)',
                border: '1px solid rgba(201,168,76,0.35)', color: '#E8C56A'
              }}
            >
              <Plus size={10} /> Novo
            </button>
          </div>
          <input
            type="text"
            placeholder="Buscar projetos..."
            value={projectSearch}
            onChange={e => setProjectSearch(e.target.value)}
            style={{ width: '100%', background: 'rgba(0,0,0,0.25)', border: '1px solid var(--glass-b)', borderRadius: 6, padding: '5px 8px', color: '#fff', fontSize: 10.5, marginBottom: 8 }}
          />
          <div style={{ maxHeight: 168, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {[...projects]
              .filter(p => p.name.toLowerCase().includes(projectSearch.trim().toLowerCase()))
              .sort((a, b) => {
                if (!!b.favorite !== !!a.favorite) return (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0);
                return new Date(b.updatedAt) - new Date(a.updatedAt);
              })
              .map(p => {
                const isActive = p.id === currentProjectId;
                return (
                  <div
                    key={p.id}
                    onClick={() => handleSelectProject(p.id)}
                    title={p.dir}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 8, cursor: 'pointer',
                      background: isActive ? 'rgba(201,168,76,0.12)' : 'rgba(255,255,255,0.02)',
                      border: `1px solid ${isActive ? '#C9A84C' : 'rgba(255,255,255,0.06)'}`,
                    }}
                  >
                    <Video size={12} style={{ opacity: 0.55, flexShrink: 0, color: isActive ? '#E8C56A' : 'var(--text-3)' }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {p.name}
                      </div>
                      <div style={{ fontSize: 9, color: 'var(--text-3)' }}>
                        Atualizado {new Date(p.updatedAt).toLocaleDateString('pt-BR')}
                      </div>
                    </div>
                    <button
                      onClick={(e) => handleToggleFavorite(p.id, e)}
                      title={p.favorite ? 'Remover dos favoritos' : 'Favoritar'}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: p.favorite ? '#E8C56A' : 'var(--text-3)', flexShrink: 0, lineHeight: 1 }}
                    >
                      {p.favorite ? '★' : '☆'}
                    </button>
                  </div>
                );
              })}
            {loadingProjects && <div style={{ fontSize: 10, color: 'var(--text-3)', padding: '6px 2px' }}>Carregando projetos...</div>}
            {!loadingProjects && projects.length === 0 && (
              <div style={{ fontSize: 10, color: 'var(--text-3)', padding: '6px 2px' }}>Nenhum projeto ainda — clique em "Novo".</div>
            )}
          </div>
        </div>

        {/* Workspace path */}
        <div>
          <label style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-3)' }}>Caminho do Diretório</label>
          <input
            type="text" readOnly value={workspace}
            style={{ width: '100%', background: 'rgba(0,0,0,0.3)', border: '1px solid var(--glass-b)', borderRadius: 6, padding: 6, color: '#fff', fontSize: 11, marginTop: 4 }}
          />
        </div>

        {/* Upload zone */}
        <div>
          <label style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-3)', display: 'block', marginBottom: 4 }}>Subir Novo Vídeo</label>
          <input
            type="file" accept="video/mp4,video/quicktime,video/x-msvideo,application/json"
            multiple ref={fileInputRef} onChange={handleFileUpload} style={{ display: 'none' }}
          />
          <div
            onClick={() => !uploading && fileInputRef.current?.click()}
            style={{
              border: '2px dashed rgba(201,168,76,0.3)', background: 'rgba(201,168,76,0.02)',
              borderRadius: 10, padding: '14px 12px', textAlign: 'center',
              cursor: uploading ? 'not-allowed' : 'pointer', transition: 'all 0.2s',
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6
            }}
            onDragOver={e => { e.preventDefault(); e.currentTarget.style.borderColor = 'rgba(201,168,76,0.6)'; }}
            onDragLeave={e => { e.preventDefault(); e.currentTarget.style.borderColor = 'rgba(201,168,76,0.3)'; }}
            onDrop={e => {
              e.preventDefault();
              if (uploading) return;
              e.currentTarget.style.borderColor = 'rgba(201,168,76,0.3)';
              const dropped = Array.from(e.dataTransfer.files || []);
              if (dropped.length > 0) handleFileUpload({ target: { files: dropped } });
            }}
          >
            {uploading ? (
              <>
                <RefreshCw size={18} className="spin" color="#E8C56A" />
                <span style={{ fontSize: 11, color: 'var(--text-2)', fontWeight: 600 }}>Enviando ({uploadProgress}%)</span>
                <div style={{ width: 110, height: 3, background: 'rgba(255,255,255,0.06)', borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{ width: `${uploadProgress}%`, height: '100%', background: '#E8C56A', transition: 'width 0.1s' }} />
                </div>
              </>
            ) : (
              <>
                <Upload size={18} color="#E8C56A" />
                <span style={{ fontSize: 11, color: 'var(--text-2)', fontWeight: 600 }}>Arraste vídeo/legenda ou clique</span>
                <span style={{ fontSize: 8.5, color: 'var(--text-3)' }}>Vídeos (MP4/MOV) ou JSON Transkriptor</span>
              </>
            )}
          </div>
        </div>

        {/* Server toggle */}
        <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--glass-b)', borderRadius: 8, padding: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-2)' }}>Servidor de Preview</span>
            <span style={{
              fontSize: 10, fontWeight: 800, padding: '2px 6px', borderRadius: 4,
              background: serverActive ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)',
              color: serverActive ? '#22C55E' : '#EF4444'
            }}>
              {serverActive ? 'ATIVO' : 'OFFLINE'}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={handleStartServer} disabled={serverActive} className="ghost-btn"
              style={{ flex: 1, padding: 6, fontSize: 11, background: !serverActive ? 'rgba(201,168,76,0.1)' : 'transparent', color: !serverActive ? '#E8C56A' : 'var(--text-3)', borderColor: 'rgba(201,168,76,0.2)' }}>
              <Power size={11} style={{ marginRight: 4 }} /> Ligar
            </button>
            <button onClick={handleStopServer} disabled={!serverActive} className="ghost-btn"
              style={{ flex: 1, padding: 6, fontSize: 11, background: serverActive ? 'rgba(239,68,68,0.1)' : 'transparent', color: serverActive ? '#F87171' : 'var(--text-3)', borderColor: 'rgba(239,68,68,0.2)' }}>
              <Power size={11} style={{ marginRight: 4 }} /> Desligar
            </button>
          </div>
        </div>

        {/* ── Video list with rubber-band ── */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {/* Toolbar */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="checkbox"
                title="Selecionar todos visíveis"
                checked={sortedAndFilteredFiles.length > 0 && sortedAndFilteredFiles.every(v => selectedVideos.includes(v.name))}
                onChange={e => {
                  if (e.target.checked) {
                    setSelectedVideos(prev => Array.from(new Set([...prev, ...sortedAndFilteredFiles.map(v => v.name)])));
                  } else {
                    setSelectedVideos(prev => prev.filter(name => !sortedAndFilteredFiles.some(f => f.name === name)));
                  }
                }}
                style={{ cursor: 'pointer' }}
              />
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-2)' }}>
                Vídeos ({sortedAndFilteredFiles.length})
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {selectedVideos.length > 0 && (
                <button
                  onClick={handleDeleteSelected}
                  title={`Excluir ${selectedVideos.length} vídeo(s) selecionado(s)`}
                  style={{
                    background: 'rgba(239,68,68,0.14)', border: '1px solid rgba(239,68,68,0.35)',
                    borderRadius: 6, padding: '4px 9px', color: '#F87171', cursor: 'pointer',
                    fontSize: 10.5, fontWeight: 800, display: 'flex', alignItems: 'center', gap: 5
                  }}>
                  <Trash2 size={11} /> Excluir ({selectedVideos.length})
                </button>
              )}
              <button onClick={loadVideos} disabled={loadingVideos}
                style={{ background: 'none', border: 'none', color: '#C9A84C', cursor: 'pointer' }}>
                <RefreshCw size={12} className={loadingVideos ? 'spin' : ''} />
              </button>
            </div>
          </div>

          {/* Category Filter & Sorting Row */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 6 }}>
            <div style={{ display: 'flex', gap: 4 }}>
              <button
                onClick={() => setCategoryFilter('all')}
                style={{
                  padding: '3px 6px', fontSize: 9, fontWeight: 700, borderRadius: 6, cursor: 'pointer',
                  background: categoryFilter === 'all' ? 'rgba(201,168,76,0.2)' : 'rgba(255,255,255,0.02)',
                  border: `1px solid ${categoryFilter === 'all' ? '#C9A84C' : 'rgba(255,255,255,0.08)'}`,
                  color: categoryFilter === 'all' ? '#E8C56A' : 'var(--text-3)',
                  transition: 'all 0.15s'
                }}
              >
                Todos
              </button>
              <button
                onClick={() => setCategoryFilter('raw')}
                style={{
                  padding: '3px 6px', fontSize: 9, fontWeight: 700, borderRadius: 6, cursor: 'pointer',
                  background: categoryFilter === 'raw' ? 'rgba(201,168,76,0.2)' : 'rgba(255,255,255,0.02)',
                  border: `1px solid ${categoryFilter === 'raw' ? '#C9A84C' : 'rgba(255,255,255,0.08)'}`,
                  color: categoryFilter === 'raw' ? '#E8C56A' : 'var(--text-3)',
                  transition: 'all 0.15s'
                }}
              >
                Brutos
              </button>
              <button
                onClick={() => setCategoryFilter('exported')}
                style={{
                  padding: '3px 6px', fontSize: 9, fontWeight: 700, borderRadius: 6, cursor: 'pointer',
                  background: categoryFilter === 'exported' ? 'rgba(201,168,76,0.2)' : 'rgba(255,255,255,0.02)',
                  border: `1px solid ${categoryFilter === 'exported' ? '#C9A84C' : 'rgba(255,255,255,0.08)'}`,
                  color: categoryFilter === 'exported' ? '#E8C56A' : 'var(--text-3)',
                  transition: 'all 0.15s'
                }}
              >
                Exportados
              </button>
            </div>
            <button
              onClick={() => setSortBy(prev => prev === 'date' ? 'name' : 'date')}
              title={`Ordenar por: ${sortBy === 'date' ? 'Nome' : 'Data'}`}
              style={{
                padding: '3px 6px', fontSize: 9, fontWeight: 700, borderRadius: 6, cursor: 'pointer',
                background: 'rgba(255,255,255,0.02)',
                border: '1px solid rgba(255,255,255,0.08)',
                color: 'var(--text-2)', display: 'flex', alignItems: 'center', gap: 4
              }}
            >
              {sortBy === 'date' ? <Clock size={10} /> : <ArrowUpDown size={10} />}
              {sortBy === 'date' ? 'Mais Recentes' : 'Nome (A-Z)'}
            </button>
          </div>

          {/* List container — rubber-band root */}
          <div
            ref={listRef}
            onMouseDown={onListMouseDown}
            style={{
              flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4,
              position: 'relative',
              userSelect: 'none',
              cursor: 'default'
            }}
          >
            {/* Rubber-band box */}
            {rubberBand && (
              <div style={{
                position: 'absolute', pointerEvents: 'none', zIndex: 99,
                left: rubberBand.x, top: rubberBand.y,
                width: rubberBand.w, height: rubberBand.h,
                border: '1.5px solid rgba(99,102,241,0.8)',
                background: 'rgba(99,102,241,0.12)',
                borderRadius: 4
              }} />
            )}

            {sortedAndFilteredFiles.length === 0 ? (
              <div style={{ padding: '20px 10px', textTransform: 'uppercase', color: 'var(--text-3)', fontSize: 9, textAlign: 'center' }}>
                {videoFiles.length === 0 
                  ? "Nenhum arquivo de vídeo encontrado. Insira arquivos .mp4 ou .mov na pasta."
                  : "Nenhum vídeo encontrado nesta categoria."}
              </div>
            ) : (
              sortedAndFilteredFiles.map((v, idx) => {
                const isSelected = selectedVideos.includes(v.name);
                const isProcessed = processedVideos.has(v.name);
                const isDragOver = dragOverIdx === idx;
                const fullPath = `${workspace}\\${v.name}`;
                return (
                  <div
                    key={v.name}
                    ref={el => itemRefs.current[idx] = el}
                    draggable
                    onDragStart={() => { dragSrcIdx.current = idx; }}
                    onDragOver={e => { e.preventDefault(); setDragOverIdx(idx); }}
                    onDragLeave={() => setDragOverIdx(null)}
                    onDrop={e => {
                      e.preventDefault(); setDragOverIdx(null);
                      const from = dragSrcIdx.current;
                      if (from === null || from === idx) return;
                      const next = [...videoFiles];
                      const fromFile = sortedAndFilteredFiles[from];
                      const toFile = sortedAndFilteredFiles[idx];
                      const fromIdxInOriginal = videoFiles.findIndex(f => f.name === fromFile.name);
                      const toIdxInOriginal = videoFiles.findIndex(f => f.name === toFile.name);
                      if (fromIdxInOriginal !== -1 && toIdxInOriginal !== -1) {
                        const [moved] = next.splice(fromIdxInOriginal, 1);
                        next.splice(toIdxInOriginal, 0, moved);
                        setVideoFiles(next);
                      }
                      dragSrcIdx.current = null;
                    }}
                    onDragEnd={() => setDragOverIdx(null)}
                    style={{
                      background: isDragOver ? 'rgba(99,102,241,0.12)' : isSelected ? 'rgba(201,168,76,0.08)' : 'rgba(255,255,255,0.02)',
                      border: `1px solid ${isDragOver ? 'rgba(99,102,241,0.5)' : isSelected ? 'rgba(201,168,76,0.4)' : 'rgba(255,255,255,0.05)'}`,
                      borderRadius: 10, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 4,
                      cursor: 'grab', transition: 'all 0.12s', opacity: isDragOver ? 0.7 : 1,
                      flexShrink: 0
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <GripVertical size={12} style={{ color: 'var(--text-3)', flexShrink: 0 }} />
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => setSelectedVideos(prev =>
                          prev.includes(v.name) ? prev.filter(x => x !== v.name) : [...prev, v.name]
                        )}
                        onClick={e => e.stopPropagation()}
                        style={{ cursor: 'pointer', flexShrink: 0 }}
                      />
                      <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                        {v.name}
                      </div>
                      {isProcessed && (
                        <span style={{ fontSize: 8, fontWeight: 800, padding: '1px 5px', borderRadius: 4, background: 'rgba(16,185,129,0.15)', color: '#34D399', flexShrink: 0 }}>✓ INCLUÍDO</span>
                      )}
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingLeft: 28 }}>
                      <span style={{ fontSize: 9, color: 'var(--text-3)' }}>{(v.size / 1024 / 1024).toFixed(1)} MB</span>
                      
                      {/* Hierarquia clara em vez de 3 botões iguais: Incluir é a
                          AÇÃO PRINCIPAL (pílula cheia), pré-visualizar/excluir
                          são só ícones discretos ao lado — não competem por
                          atenção com a ação que realmente importa aqui. */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5, justifyContent: 'flex-end' }}>
                        <button
                          onClick={e => { e.stopPropagation(); handleViewVideo(fullPath, v.name); }}
                          title="Pré-visualizar"
                          style={{
                            width: 20, height: 20, padding: 0, borderRadius: 5, cursor: 'pointer',
                            background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
                            color: 'var(--text-3)', display: 'flex', alignItems: 'center', justifyContent: 'center'
                          }}
                        >
                          <Eye size={11} />
                        </button>

                        <button
                          onClick={e => {
                            e.stopPropagation();
                            if (window.confirm(`Tem certeza que deseja excluir o vídeo ${v.name}? Essa ação não pode ser desfeita.`)) {
                              handleDeleteIndividual(v.name);
                            }
                          }}
                          title="Excluir permanentemente"
                          style={{
                            width: 20, height: 20, padding: 0, borderRadius: 5, cursor: 'pointer',
                            background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
                            color: 'var(--text-3)', display: 'flex', alignItems: 'center', justifyContent: 'center'
                          }}
                        >
                          <Trash2 size={11} />
                        </button>

                        <button
                          onClick={e => { e.stopPropagation(); handleIncluirVideo(v.name); }}
                          disabled={runningCmd}
                          title={isProcessed ? 'Já incluído — clique pra incluir de novo (com opção de camada)' : 'Incluir na sequência ou como camada de vídeo'}
                          style={{
                            padding: '3px 10px', fontSize: 9.5, fontWeight: 800, borderRadius: 999, cursor: 'pointer',
                            background: isProcessed ? 'rgba(16,185,129,0.14)' : 'linear-gradient(90deg, #C9A84C, #9C7830)',
                            border: isProcessed ? '1px solid rgba(16,185,129,0.35)' : 'none',
                            color: isProcessed ? '#34D399' : '#0b0e13'
                          }}
                        >
                          {isProcessed ? 'Re-incluir' : 'Incluir'}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Bottom actions */}
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          
          {/* Card do último arquivo exportado */}
          {lastExportedPath && (
            <div style={{
              background: 'linear-gradient(135deg, rgba(16,185,129,0.12), rgba(201,168,76,0.12))',
              border: '1px solid rgba(16,185,129,0.35)',
              borderRadius: 8, padding: 10, display: 'flex', flexDirection: 'column', gap: 8
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 10, fontWeight: 800, color: '#34D399', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <CheckCircle2 size={12} /> VÍDEO EXPORTADO PRONTO
                </span>
                <span style={{ fontSize: 9, color: 'var(--text-3)' }}>
                  {lastExportedPath.split('\\').pop()}
                </span>
              </div>

              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  onClick={() => handleOpenFileLocation(lastExportedPath)}
                  style={{
                    flex: 1, padding: '7px 8px', fontSize: 10, fontWeight: 800, borderRadius: 6, cursor: 'pointer',
                    background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)',
                    color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4
                  }}
                  title="Abre a pasta no Explorer com o arquivo selecionado"
                >
                  <FolderOpen size={12} color="#E8C56A" /> ABRIR LOCAL DO ARQUIVO
                </button>

                <button
                  onClick={() => handleViewVideo(lastExportedPath)}
                  style={{
                    flex: 1, padding: '7px 8px', fontSize: 10, fontWeight: 800, borderRadius: 6, cursor: 'pointer',
                    background: 'linear-gradient(90deg, #10B981, #059669)', border: 'none',
                    color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4
                  }}
                  title="Abre o vídeo no player do sistema e no preview"
                >
                  <Play size={12} fill="#fff" /> ABRIR VÍDEO
                </button>
              </div>
            </div>
          )}

          {selectedVideos.length > 1 && (
            <button onClick={handleAutoEdl} disabled={runningCmd} style={{
              width: '100%', background: 'linear-gradient(90deg, #10B981, #059669)',
              border: 'none', borderRadius: 8, padding: 10, color: '#fff', fontWeight: 800,
              fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6
            }}>
              {runningCmd ? <RefreshCw size={13} className="spin" /> : <Plus size={13} />}
              Incluir Todos ({selectedVideos.length} vídeos)
            </button>
          )}

          {/* "Renderizar Preview" e "Aplicar Novo Estilo" saíram daqui: o botão
              "Aplicar estilo" dentro do próprio editor (coluna da direita) já
              salva E dispara a aplicação sozinho (o watcher em server.js pega
              o preview_style.json e roda automaticamente) — clicar de novo
              aqui fora seria só duplicar a mesma ação por outro caminho. */}

          {/* Final export - full quality with voice master */}
          <button onClick={() => handleRender('final')} disabled={runningCmd} style={{
            width: '100%', background: 'linear-gradient(90deg, #7C3AED, #5B21B6)',
            border: 'none', borderRadius: 8, padding: 10, color: '#fff', fontWeight: 800,
            fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6
          }}>
            {runningCmd ? <RefreshCw size={13} className="spin" /> : <Play size={13} />}
            ⭐ Exportar Vídeo Final
          </button>

          {/* Destructive: clear entire timeline */}
          <button
            onClick={handleClearTimeline}
            title="Apaga o EDL, cortes e clips processados. Vídeos originais ficam intactos."
            style={{
              width: '100%', background: 'rgba(239,68,68,0.06)',
              border: '1px solid rgba(239,68,68,0.25)',
              borderRadius: 8, padding: 8, color: '#F87171', fontWeight: 700,
              fontSize: 11, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6
            }}>
            <Trash2 size={12} /> Limpar Timeline
          </button>
        </div>
      </div>

      {/* ── Coluna Central: Timeline + Console ── */}
      <div style={{ display: 'grid', gridTemplateRows: '1fr 140px', gap: 16 }}>
        {/* Editor iframe */}
        <div className="card" style={{ padding: 0, overflow: 'hidden', position: 'relative', background: '#09070f' }}>
          {serverActive ? (
            <iframe
              src={`http://127.0.0.1:${port}/`}
              title="Assyma Video Editor Timeline"
              style={{ width: '100%', height: '100%', border: 'none' }}
            />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 12, color: 'var(--text-3)' }}>
              <Video size={42} style={{ opacity: 0.15 }} />
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-2)' }}>Servidor de Preview Offline</div>
              <p style={{ fontSize: 11, margin: 0, textAlign: 'center', maxWidth: 300, lineHeight: 1.45 }}>
                Ative o servidor na coluna da esquerda para carregar a timeline do editor interativo da Assyma.
              </p>
              <button onClick={handleStartServer}
                style={{ background: '#C9A84C', border: 'none', borderRadius: 8, padding: '8px 16px', color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer', marginTop: 4 }}>
                Ativar Servidor
              </button>
            </div>
          )}
        </div>

        {/* Console */}
        <div className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 6, minHeight: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 800, color: 'var(--text-3)' }}>
            <Terminal size={12} /> CONSOLE DE EXECUÇÃO
          </div>
          <div style={{
            flex: 1, background: '#07050a', border: '1px solid rgba(255,255,255,0.05)',
            borderRadius: 6, padding: '8px 12px', fontFamily: 'monospace', fontSize: 10,
            color: '#A7F3D0', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4
          }}>
            {logs.map((log, idx) => (
              <div key={idx}>{log}</div>
            ))}
            <div ref={logsEndRef} />
          </div>
        </div>
      </div>

      {/* Modal de Player de Vídeo */}
      {previewModalVideo && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(8px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20
        }}>
          <div style={{
            background: '#120f1d', border: '1px solid var(--glass-b)',
            borderRadius: 12, width: '100%', maxWidth: 720, padding: 18,
            display: 'flex', flexDirection: 'column', gap: 14, boxShadow: '0 20px 40px rgba(0,0,0,0.6)'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <FileVideo size={18} color="#EC4899" />
                <span style={{ fontSize: 13, fontWeight: 800, color: '#fff' }}>{previewModalVideo.name}</span>
              </div>
              <button
                onClick={() => setPreviewModalVideo(null)}
                style={{ background: 'none', border: 'none', color: 'var(--text-3)', cursor: 'pointer' }}
              >
                <X size={18} />
              </button>
            </div>

            <div style={{ background: '#000', borderRadius: 8, overflow: 'hidden', display: 'flex', justifyContent: 'center' }}>
              <video
                src={`${API}/api/assyma-studio/stream?path=${encodeURIComponent(previewModalVideo.path)}`}
                controls
                autoPlay
                style={{ maxWidth: '100%', maxHeight: 440, borderRadius: 8 }}
              />
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 12 }}>
              <span style={{ fontSize: 10, color: 'var(--text-3)', fontFamily: 'monospace' }}>
                {previewModalVideo.path}
              </span>

              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={() => handleOpenFileLocation(previewModalVideo.path)}
                  style={{
                    padding: '8px 12px', fontSize: 11, fontWeight: 700, borderRadius: 6, cursor: 'pointer',
                    background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.15)', color: '#fff',
                    display: 'flex', alignItems: 'center', gap: 6
                  }}
                >
                  <FolderOpen size={13} color="#E8C56A" /> ABRIR LOCAL DO ARQUIVO
                </button>
                <button
                  onClick={() => handleViewVideo(previewModalVideo.path, previewModalVideo.name)}
                  style={{
                    padding: '8px 12px', fontSize: 11, fontWeight: 700, borderRadius: 6, cursor: 'pointer',
                    background: '#C9A84C', border: 'none', color: '#fff',
                    display: 'flex', alignItems: 'center', gap: 6
                  }}
                >
                  <Play size={13} fill="#fff" /> ABRIR NO PLAYER DO SISTEMA
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

