"""Chroma persistence and configurable embedding providers."""

from __future__ import annotations

from collections.abc import Sequence
import hashlib
import json
import math
from pathlib import Path
import re
from typing import Any, Protocol

import chromadb
from chromadb.config import Settings

from tools.chunking import Chunk


class EmbeddingProvider(Protocol):
    def embed_documents(self, texts: list[str]) -> list[list[float]]: ...

    def embed_query(self, text: str) -> list[float]: ...


class HashEmbedding:
    """Small deterministic embedding for tests and explicit offline fallback."""

    def __init__(self, dimensions: int = 384) -> None:
        self.dimensions = dimensions

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return [self._embed(text) for text in texts]

    def embed_query(self, text: str) -> list[float]:
        return self._embed(text)

    def _embed(self, text: str) -> list[float]:
        vector = [0.0] * self.dimensions
        for token in _tokens(text):
            digest = hashlib.blake2b(token.encode("utf-8"), digest_size=8).digest()
            index = int.from_bytes(digest[:4], "big") % self.dimensions
            sign = 1.0 if digest[4] & 1 else -1.0
            vector[index] += sign
        norm = math.sqrt(sum(value * value for value in vector)) or 1.0
        return [value / norm for value in vector]


class SentenceTransformerEmbedding:
    def __init__(self, model_name: str) -> None:
        from sentence_transformers import SentenceTransformer

        self._model = SentenceTransformer(model_name)

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        vectors = self._model.encode(texts, normalize_embeddings=True)
        return [vector.tolist() for vector in vectors]

    def embed_query(self, text: str) -> list[float]:
        return self.embed_documents([text])[0]


class OpenAIEmbedding:
    def __init__(self, model: str, *, api_key: str, base_url: str | None = None) -> None:
        from langchain_openai import OpenAIEmbeddings

        self._client = OpenAIEmbeddings(model=model, api_key=api_key, base_url=base_url)

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return self._client.embed_documents(texts)

    def embed_query(self, text: str) -> list[float]:
        return self._client.embed_query(text)


class PaperVectorStore:
    COLLECTION_NAME = "paper_chunks"

    def __init__(self, persist_directory: str | Path, embedding: EmbeddingProvider) -> None:
        path = Path(persist_directory)
        path.mkdir(parents=True, exist_ok=True)
        self.embedding = embedding
        self.client = chromadb.PersistentClient(
            path=str(path), settings=Settings(anonymized_telemetry=False)
        )
        self.collection = self.client.get_or_create_collection(
            self.COLLECTION_NAME,
            metadata={"hnsw:space": "cosine", "description": "Paper paragraph chunks"},
        )

    def upsert_paper(self, paper_id: str, title: str, chunks: Sequence[Chunk]) -> int:
        if not paper_id.strip():
            raise ValueError("paper_id cannot be empty")
        self.delete_paper(paper_id)
        if not chunks:
            return 0
        documents = [chunk.content for chunk in chunks]
        metadatas = [self._chunk_metadata(paper_id, title, chunk) for chunk in chunks]
        ids = [f"{paper_id}:{chunk.chunk_id}" for chunk in chunks]
        self.collection.upsert(
            ids=ids,
            documents=documents,
            metadatas=metadatas,
            embeddings=self.embedding.embed_documents(documents),
        )
        return len(chunks)

    def delete_paper(self, paper_id: str) -> None:
        self.collection.delete(where={"paper_id": paper_id})

    def query(
        self,
        query: str,
        *,
        paper_id: str | None = None,
        k: int = 5,
    ) -> list[dict[str, Any]]:
        if not query.strip() or k <= 0 or self.collection.count() == 0:
            return []
        where = {"paper_id": paper_id} if paper_id else None
        result = self.collection.query(
            query_embeddings=[self.embedding.embed_query(query)],
            n_results=min(k, self.collection.count()),
            where=where,
            include=["documents", "metadatas", "distances"],
        )
        records: list[dict[str, Any]] = []
        for index, document in enumerate((result.get("documents") or [[]])[0]):
            metadata = (result.get("metadatas") or [[]])[0][index] or {}
            distance = float((result.get("distances") or [[]])[0][index])
            records.append(
                {
                    "id": (result.get("ids") or [[]])[0][index],
                    "document": document,
                    "metadata": metadata,
                    "distance": distance,
                }
            )
        return records

    def list_papers(self) -> list[dict[str, str]]:
        result = self.collection.get(include=["metadatas"])
        papers: dict[str, str] = {}
        for metadata in result.get("metadatas") or []:
            if metadata:
                papers[str(metadata["paper_id"])] = str(metadata["paper_title"])
        return [
            {"paper_id": paper_id, "title": title}
            for paper_id, title in sorted(papers.items(), key=lambda item: item[1].casefold())
        ]

    def count_paper(self, paper_id: str) -> int:
        result = self.collection.get(where={"paper_id": paper_id}, include=[])
        return len(result.get("ids") or [])

    @staticmethod
    def _chunk_metadata(paper_id: str, title: str, chunk: Chunk) -> dict[str, Any]:
        return {
            "paper_id": paper_id,
            "paper_title": title,
            "chunk_id": chunk.chunk_id,
            "section": chunk.section,
            "section_canonical": chunk.section_canonical,
            "page": chunk.page,
            "page_end": chunk.page_end,
            "para_idx": chunk.para_idx,
            "char_start": chunk.char_start,
            "char_end": chunk.char_end,
            "source_label": chunk.source_label,
            "placeholders_json": json.dumps(
                [placeholder.to_dict() for placeholder in chunk.placeholders],
                ensure_ascii=False,
            ),
        }


def _tokens(text: str) -> list[str]:
    normalized = text.casefold()
    word_tokens = re.findall(r"[a-z0-9][a-z0-9_-]+", normalized)
    cjk = re.findall(r"[\u3400-\u9fff]", normalized)
    cjk_bigrams = ["".join(cjk[index : index + 2]) for index in range(len(cjk) - 1)]
    return word_tokens + cjk + cjk_bigrams
