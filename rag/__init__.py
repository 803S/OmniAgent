"""
OmniAgent RAG 知识库模块
功能：文档自动吞噬、向量化存储、智能检索
"""

import os
import json
import hashlib
import threading
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Optional, Any, Tuple
from dataclasses import dataclass, field, asdict
from enum import Enum
from urllib.parse import urlparse

# RAG 相关库 (延迟导入，支持可选安装)
LangChainAvailable = False
ChromaAvailable = False

try:
    from langchain_text_splitters import (
        RecursiveCharacterTextSplitter,
        MarkdownHeaderTextSplitter,
        PythonCodeTextSplitter
    )
    from langchain_community.document_loaders import (
        TextLoader,
        PyPDFLoader,
        CSVLoader,
        UnstructuredURLLoader,
        UnstructuredHTMLLoader,
        UnstructuredMarkdownLoader
    )
    LangChainAvailable = True
except ImportError:
    pass

try:
    from langchain_community.vectorstores import Chroma
    from langchain_community.embeddings import HuggingFaceBgeEmbeddings
    from langchain_huggingface import HuggingFaceEmbeddings
    ChromaAvailable = True
except ImportError:
    pass

# ============================================================================
# 配置
# ============================================================================

VECTOR_DB_DIR = Path(__file__).parent / "memory" / "vector_db"
DOCUMENT_DIR = Path(__file__).parent / "memory" / "documents"

# 默认 Embedding 模型
DEFAULT_EMBEDDING_MODEL = "BAAI/bge-small-zh-v1.5"

# 分块配置
DEFAULT_CHUNK_SIZE = 500
DEFAULT_CHUNK_OVERLAP = 50

# ============================================================================
# 数据结构
# ============================================================================

class DocumentType(Enum):
    """文档类型"""
    MARKDOWN = "md"
    PDF = "pdf"
    CSV = "csv"
    DOCX = "docx"
    TXT = "txt"
    HTML = "html"
    URL = "url"
    UNKNOWN = "unknown"

@dataclass
class KnowledgeDocument:
    """知识文档"""
    id: str
    name: str
    doc_type: str
    source: str  # 文件路径或 URL
    content: str
    chunks: List[str] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)
    embedded_at: str = ""
    chunk_count: int = 0

@dataclass
class KnowledgeChunk:
    """知识块"""
    id: str
    doc_id: str
    doc_name: str
    content: str
    source: str
    metadata: Dict[str, Any] = field(default_factory=dict)

@dataclass
class RetrievalResult:
    """检索结果"""
    chunk_id: str
    doc_name: str
    content: str
    source: str
    score: float
    metadata: Dict[str, Any]

# ============================================================================
# 核心类
# ============================================================================

class DocumentProcessor:
    """文档处理器：加载 -> 分块 -> 向量化"""
    
    def __init__(
        self,
        embedding_model: str = DEFAULT_EMBEDDING_MODEL,
        chunk_size: int = DEFAULT_CHUNK_SIZE,
        chunk_overlap: int = DEFAULT_CHUNK_OVERLAP
    ):
        if not LangChainAvailable:
            raise ImportError("RAG dependencies not installed: pip install langchain-text-splitters")
        
        self.embedding_model = embedding_model
        self.chunk_size = chunk_size
        self.chunk_overlap = chunk_overlap
        
        self.text_splitter = RecursiveCharacterTextSplitter(
            chunk_size=chunk_size,
            chunk_overlap=chunk_overlap,
            length_function=len,
            separators=["\n\n", "\n", "。", "！", "？", " ", ""]
        )
        
        self.markdown_splitter = MarkdownHeaderTextSplitter(
            headers_to_split_on=[
                ("#", "title"),
                ("##", "h2"),
                ("###", "h3"),
                ("####", "h4")
            ]
        )
        
        self._embeddings = None
    
    def _get_embeddings(self):
        """获取 Embedding 模型"""
        if self._embeddings is None:
            try:
                self._embeddings = HuggingFaceEmbeddings(
                    model_name=self.embedding_model,
                    model_kwargs={'device': 'cpu'},
                    encode_kwargs={'normalize_embeddings': True}
                )
            except Exception as e:
                print(f"[RAG] Failed to load embeddings: {e}")
                return None
        return self._embeddings
    
    def detect_doc_type(self, source: str) -> DocumentType:
        """检测文档类型"""
        if source.startswith("http://") or source.startswith("https://"):
            return DocumentType.URL
        
        ext = Path(source).suffix.lower()
        type_map = {
            ".md": DocumentType.MARKDOWN,
            ".pdf": DocumentType.PDF,
            ".csv": DocumentType.CSV,
            ".docx": DocumentType.DOCX,
            ".txt": DocumentType.TXT,
            ".html": DocumentType.HTML,
            ".htm": DocumentType.HTML
        }
        return type_map.get(ext, DocumentType.UNKNOWN)
    
    def load_document(self, source: str) -> Tuple[str, DocumentType]:
        """加载文档内容"""
        doc_type = self.detect_doc_type(source)
        
        try:
            if doc_type == DocumentType.URL:
                # 网页加载
                from langchain_community.document_loaders import UnstructuredURLLoader
                loader = UnstructuredURLLoader(urls=[source])
                docs = loader.load()
                return "\n\n".join([d.page_content for d in docs]), doc_type
            
            elif doc_type == DocumentType.PDF:
                loader = PyPDFLoader(source)
                docs = loader.load()
                return "\n\n".join([d.page_content for d in docs]), doc_type
            
            elif doc_type == DocumentType.CSV:
                loader = CSVLoader(source)
                docs = loader.load()
                return "\n\n".join([d.page_content for d in docs]), doc_type
            
            elif doc_type == DocumentType.DOCX:
                loader = DocxLoader(source)
                docs = loader.load()
                return "\n\n".join([d.page_content for d in docs]), doc_type
            
            elif doc_type == DocumentType.MARKDOWN:
                loader = UnstructuredMarkdownLoader(source)
                docs = loader.load()
                return "\n\n".join([d.page_content for d in docs]), doc_type
            
            else:
                # 通用文本
                with open(source, 'r', encoding='utf-8') as f:
                    return f.read(), doc_type
        
        except Exception as e:
            raise ValueError(f"Failed to load {source}: {e}")
    
    def split_text(self, content: str, doc_type: DocumentType) -> List[str]:
        """分块"""
        if doc_type == DocumentType.MARKDOWN:
            # Markdown 按标题分块
            splits = self.markdown_splitter.split_text(content)
            chunks = [s.page_content for s in splits]
        else:
            # 普通文本按段落分块
            chunks = self.text_splitter.split_text(content)
        
        # 过滤空块
        return [c.strip() for c in chunks if c.strip()]
    
    def process(self, source: str, metadata: Dict = None) -> KnowledgeDocument:
        """完整处理流程：加载 -> 分块"""
        content, doc_type = self.load_document(source)
        chunks = self.split_text(content, doc_type)
        
        doc_id = hashlib.md5((source + datetime.now().isoformat()).encode()).hexdigest()[:12]
        
        return KnowledgeDocument(
            id=doc_id,
            name=Path(source).name if not source.startswith("http") else urlparse(source).netloc,
            doc_type=doc_type.value,
            source=source,
            content=content[:5000],  # 保留前 5000 字符
            chunks=chunks,
            metadata=metadata or {},
            embedded_at="",
            chunk_count=len(chunks)
        )


class VectorStore:
    """向量存储"""
    
    def __init__(self, persist_directory: str = None, embedding_model: str = DEFAULT_EMBEDDING_MODEL):
        self.persist_directory = Path(persist_directory or VECTOR_DB_DIR)
        self.persist_directory.mkdir(parents=True, exist_ok=True)
        self.embedding_model = embedding_model
        
        self._vectorstore = None
        self._embeddings = None
        self._lock = threading.Lock()
    
    def _get_embeddings(self):
        """获取 Embedding 模型"""
        if self._embeddings is None:
            try:
                self._embeddings = HuggingFaceEmbeddings(
                    model_name=self.embedding_model,
                    model_kwargs={'device': 'cpu'},
                    encode_kwargs={'normalize_embeddings': True}
                )
            except Exception as e:
                print(f"[RAG] Embeddings error: {e}")
                return None
        return self._embeddings
    
    def _get_vectorstore(self):
        """获取向量存储"""
        if self._vectorstore is None:
            embeddings = self._get_embeddings()
            if embeddings is None:
                return None
            
            self._vectorstore = Chroma(
                persist_directory=str(self.persist_directory),
                embedding_function=embeddings
            )
        return self._vectorstore
    
    def add_documents(self, doc: KnowledgeDocument) -> Dict[str, Any]:
        """添加文档到向量库"""
        vs = self._get_vectorstore()
        if vs is None:
            return {"error": "Vector store not initialized"}
        
        # 准备元数据
        metadatas = []
        for i, chunk in enumerate(doc.chunks):
            metadatas.append({
                "doc_id": doc.id,
                "doc_name": doc.name,
                "doc_type": doc.doc_type,
                "source": doc.source,
                "chunk_index": i,
                "chunk_count": doc.chunk_count,
                **doc.metadata
            })
        
        # 添加到向量库
        vs.add_texts(doc.chunks, metadatas)
        
        return {
            "status": "ok",
            "doc_id": doc.id,
            "chunks_added": len(doc.chunks)
        }
    
    def search(self, query: str, top_k: int = 5, filter_dict: Dict = None) -> List[RetrievalResult]:
        """相似度检索"""
        vs = self._get_vectorstore()
        if vs is None:
            return []
        
        try:
            results = vs.similarity_search_with_score(
                query,
                k=top_k,
                filter=filter_dict
            )
            
            retrieval_results = []
            for doc, score in results:
                # Chroma 返回的 score 越小越好，转换为 0-1 的相似度
                similarity = 1 / (1 + score)
                
                retrieval_results.append(RetrievalResult(
                    chunk_id=doc.metadata.get("chunk_id", doc.metadata.get("doc_id", "")),
                    doc_name=doc.metadata.get("doc_name", ""),
                    content=doc.page_content,
                    source=doc.metadata.get("source", ""),
                    score=round(similarity, 4),
                    metadata=doc.metadata
                ))
            
            return retrieval_results
        
        except Exception as e:
            print(f"[RAG] Search error: {e}")
            return []
    
    def delete_by_doc_id(self, doc_id: str) -> Dict[str, Any]:
        """删除文档"""
        vs = self._get_vectorstore()
        if vs is None:
            return {"error": "Vector store not initialized"}
        
        # 获取该文档的所有块
        results = vs.get(where={"doc_id": doc_id})
        if results and results.get("ids"):
            vs.delete(ids=results["ids"])
            return {"status": "ok", "deleted": len(results["ids"])}
        
        return {"status": "ok", "deleted": 0}
    
    def get_stats(self) -> Dict[str, Any]:
        """获取向量库统计"""
        vs = self._get_vectorstore()
        if vs is None:
            return {"error": "Vector store not initialized"}
        
        try:
            count = vs._collection.count()
            return {
                "total_chunks": count,
                "persist_directory": str(self.persist_directory),
                "embedding_model": self.embedding_model
            }
        except Exception as e:
            return {"error": str(e)}


class AutoIngest:
    """自动吞噬：监听/处理新文档"""
    
    def __init__(self, vector_store: VectorStore, document_processor: DocumentProcessor):
        self.vector_store = vector_store
        self.processor = document_processor
        self.document_dir = DOCUMENT_DIR
        self.document_dir.mkdir(parents=True, exist_ok=True)
    
    def ingest_file(self, file_path: str, metadata: Dict = None) -> Dict[str, Any]:
        """吞噬文件"""
        try:
            # 处理文档
            doc = self.processor.process(file_path, metadata)
            
            # 保存原始文件引用
            doc.embedded_at = datetime.now().isoformat()
            
            # 添加到向量库
            result = self.vector_store.add_documents(doc)
            
            # 保存元数据
            meta_file = self.document_dir / f"{doc.id}.json"
            meta_file.write_text(json.dumps(asdict(doc), ensure_ascii=False, indent=2))
            
            return {
                "status": "ok",
                "doc_id": doc.id,
                "doc_name": doc.name,
                "chunk_count": doc.chunk_count,
                **result
            }
        
        except Exception as e:
            return {"error": str(e), "source": file_path}
    
    def ingest_url(self, url: str, metadata: Dict = None) -> Dict[str, Any]:
        """吞噬 URL"""
        metadata = metadata or {}
        metadata["ingested_at"] = datetime.now().isoformat()
        
        return self.ingest_file(url, metadata)
    
    def ingest_directory(self, directory: str, extensions: List[str] = None) -> Dict[str, Any]:
        """吞噬目录下的所有文件"""
        extensions = extensions or [".md", ".txt", ".pdf", ".csv", ".docx"]
        dir_path = Path(directory)
        
        results = {
            "total": 0,
            "success": 0,
            "failed": 0,
            "details": []
        }
        
        for ext in extensions:
            for file_path in dir_path.rglob(f"*{ext}"):
                results["total"] += 1
                result = self.ingest_file(str(file_path))
                
                if "error" in result:
                    results["failed"] += 1
                    results["details"].append(result)
                else:
                    results["success"] += 1
        
        return results
    
    def list_documents(self) -> List[Dict]:
        """列出已吞噬的文档"""
        docs = []
        for f in self.document_dir.glob("*.json"):
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
                docs.append({
                    "id": data.get("id"),
                    "name": data.get("name"),
                    "type": data.get("doc_type"),
                    "source": data.get("source"),
                    "chunk_count": data.get("chunk_count"),
                    "embedded_at": data.get("embedded_at")
                })
            except Exception:
                continue
        return sorted(docs, key=lambda x: x.get("embedded_at", ""), reverse=True)


class SimpleKnowledgeBase:
    """轻量级无向量依赖的知识库 fallback，保证用户可直接测试 add/search 流程。"""

    def __init__(self):
        self.document_dir = DOCUMENT_DIR
        self.document_dir.mkdir(parents=True, exist_ok=True)

    def _load_text(self, source: str) -> str:
        if source.startswith("http://") or source.startswith("https://"):
            import requests
            resp = requests.get(source, timeout=30)
            resp.raise_for_status()
            return resp.text
        with open(source, 'r', encoding='utf-8', errors='ignore') as f:
            return f.read()

    def _iter_docs(self):
        for f in self.document_dir.glob('*.json'):
            try:
                yield json.loads(f.read_text(encoding='utf-8'))
            except Exception:
                continue

    def add_knowledge(self, source: str, metadata: Dict = None) -> Dict:
        content = self._load_text(source)
        chunks = [content[i:i + DEFAULT_CHUNK_SIZE] for i in range(0, len(content), DEFAULT_CHUNK_SIZE)] or [content]
        doc_id = hashlib.md5((source + datetime.now().isoformat()).encode()).hexdigest()[:12]
        payload = {
            'id': doc_id,
            'name': Path(source).name if not source.startswith('http') else urlparse(source).netloc,
            'doc_type': DocumentType.URL.value if source.startswith('http') else Path(source).suffix.lstrip('.').lower() or 'txt',
            'source': source,
            'content': content[:5000],
            'chunks': chunks,
            'metadata': metadata or {},
            'embedded_at': datetime.now().isoformat(),
            'chunk_count': len(chunks),
            'mode': 'simple'
        }
        (self.document_dir / f'{doc_id}.json').write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
        return {'status': 'ok', 'doc_id': doc_id, 'doc_name': payload['name'], 'chunk_count': len(chunks), 'mode': 'simple'}

    def search(self, query: str, top_k: int = 5) -> List[RetrievalResult]:
        tokens = [t.lower() for t in query.split() if t.strip()]
        results = []
        for doc in self._iter_docs():
            for chunk in doc.get('chunks', []):
                haystack = chunk.lower()
                score = sum(haystack.count(token) for token in tokens) if tokens else 0
                if score > 0 or query.lower() in haystack:
                    similarity = round(min(1.0, 0.2 + score * 0.15), 4)
                    results.append(RetrievalResult(
                        chunk_id=doc.get('id', ''),
                        doc_name=doc.get('name', ''),
                        content=chunk,
                        source=doc.get('source', ''),
                        score=similarity,
                        metadata=doc.get('metadata', {}),
                    ))
        results.sort(key=lambda item: item.score, reverse=True)
        return results[:top_k]

    def get_stats(self) -> Dict:
        docs = list(self._iter_docs())
        return {
            'vector_db': {'mode': 'simple', 'total_chunks': sum(doc.get('chunk_count', 0) for doc in docs)},
            'documents': {'total': len(docs), 'list': [
                {'id': doc.get('id'), 'name': doc.get('name'), 'type': doc.get('doc_type'), 'source': doc.get('source'), 'chunk_count': doc.get('chunk_count'), 'embedded_at': doc.get('embedded_at')}
                for doc in docs[:10]
            ]}
        }

    def delete_document(self, doc_id: str) -> Dict:
        meta_file = self.document_dir / f'{doc_id}.json'
        if meta_file.exists():
            meta_file.unlink()
            return {'status': 'ok', 'deleted': 1}
        return {'status': 'ok', 'deleted': 0}

    def list_documents(self) -> List[Dict]:
        docs = []
        for doc in self._iter_docs():
            docs.append({'id': doc.get('id'), 'name': doc.get('name'), 'type': doc.get('doc_type'), 'source': doc.get('source'), 'chunk_count': doc.get('chunk_count'), 'embedded_at': doc.get('embedded_at')})
        return sorted(docs, key=lambda x: x.get('embedded_at', ''), reverse=True)


class KnowledgeBase:
    """知识库统一入口"""

    def __init__(
        self,
        embedding_model: str = DEFAULT_EMBEDDING_MODEL,
        chunk_size: int = DEFAULT_CHUNK_SIZE,
        chunk_overlap: int = DEFAULT_CHUNK_OVERLAP
    ):
        self.simple_mode = not (LangChainAvailable and ChromaAvailable)
        if self.simple_mode:
            self.simple_kb = SimpleKnowledgeBase()
        else:
            self.processor = DocumentProcessor(embedding_model, chunk_size, chunk_overlap)
            self.vector_store = VectorStore(embedding_model=embedding_model)
            self.auto_ingest = AutoIngest(self.vector_store, self.processor)

    def add_knowledge(self, source: str, metadata: Dict = None) -> Dict:
        if self.simple_mode:
            return self.simple_kb.add_knowledge(source, metadata)
        if source.startswith("http://") or source.startswith("https://"):
            return self.auto_ingest.ingest_url(source, metadata)
        return self.auto_ingest.ingest_file(source, metadata)

    def search(self, query: str, top_k: int = 5) -> List[RetrievalResult]:
        if self.simple_mode:
            return self.simple_kb.search(query, top_k)
        return self.vector_store.search(query, top_k)

    def get_stats(self) -> Dict:
        if self.simple_mode:
            return self.simple_kb.get_stats()
        vs_stats = self.vector_store.get_stats()
        docs = self.auto_ingest.list_documents()
        return {'vector_db': vs_stats, 'documents': {'total': len(docs), 'list': docs[:10]}}

    def delete_document(self, doc_id: str) -> Dict:
        if self.simple_mode:
            return self.simple_kb.delete_document(doc_id)
        vs_result = self.vector_store.delete_by_doc_id(doc_id)
        meta_file = self.auto_ingest.document_dir / f"{doc_id}.json"
        if meta_file.exists():
            meta_file.unlink()
        return vs_result

    def list_documents(self) -> List[Dict]:
        if self.simple_mode:
            return self.simple_kb.list_documents()
        return self.auto_ingest.list_documents()


# ============================================================================
# 全局实例
# ============================================================================

_knowledge_base: Optional[KnowledgeBase] = None
_knowledge_base_lock = threading.Lock()

def get_knowledge_base() -> KnowledgeBase:
    global _knowledge_base
    if _knowledge_base is None:
        with _knowledge_base_lock:
            if _knowledge_base is None:
                _knowledge_base = KnowledgeBase()
    return _knowledge_base


def add_knowledge(source: str, metadata: Dict = None) -> Dict:
    return get_knowledge_base().add_knowledge(source, metadata)

def search_knowledge(query: str, top_k: int = 5) -> List[Dict]:
    results = get_knowledge_base().search(query, top_k)
    return [{
        'doc_name': r.doc_name,
        'content': r.content,
        'source': r.source,
        'score': r.score,
        'metadata': r.metadata
    } for r in results]

def get_knowledge_stats() -> Dict:
    return get_knowledge_base().get_stats()

def list_documents() -> List[Dict]:
    return get_knowledge_base().list_documents()

def delete_document(doc_id: str) -> Dict:
    return get_knowledge_base().delete_document(doc_id)


__all__ = [
    'KnowledgeBase', 'DocumentProcessor', 'VectorStore', 'AutoIngest', 'DocumentType', 'KnowledgeDocument', 'KnowledgeChunk', 'RetrievalResult',
    'add_knowledge', 'search_knowledge', 'get_knowledge_stats', 'list_documents', 'delete_document'
]
