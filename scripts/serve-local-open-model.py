#!/usr/bin/env python3
"""Serve a pinned Hugging Face causal LM on a tiny local OpenAI-compatible API.

This intentionally has no external web framework dependency. It is used for
the reproducible smoke evaluation of the TypeScript Tinker-compatible adapter.
The model is loaded once and greedy decoding is used so the same model files,
prompt, and observation produce the same response on the same runtime.
"""

import argparse
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer


def load_model(model_id: str):
    tokenizer = AutoTokenizer.from_pretrained(model_id)
    model = AutoModelForCausalLM.from_pretrained(model_id)
    model.eval()
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token
    return tokenizer, model


class Handler(BaseHTTPRequestHandler):
    tokenizer = None
    model = None
    model_id = ""

    def log_message(self, format, *args):
        print("local-model:", format % args, flush=True)

    def _send(self, status, payload):
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path == "/health" or self.path == "/v1/health":
            self._send(200, {"status": "ok", "model": self.model_id})
            return
        self._send(404, {"error": {"message": "not found"}})

    def do_POST(self):
        if self.path != "/v1/chat/completions":
            self._send(404, {"error": {"message": "not found"}})
            return
        try:
            size = int(self.headers.get("content-length", "0"))
            request = json.loads(self.rfile.read(size))
            messages = request.get("messages")
            if not isinstance(messages, list) or not messages:
                raise ValueError("messages must be a non-empty list")
            if hasattr(self.tokenizer, "apply_chat_template"):
                prompt = self.tokenizer.apply_chat_template(
                    messages, tokenize=False, add_generation_prompt=True
                )
            else:
                prompt = "\n".join(
                    f"{message.get('role', 'user')}: {message.get('content', '')}"
                    for message in messages
                ) + "\nassistant:"
            # Keep the system prompt and the leading overview/roster fields
            # inside the small model's context window. The TypeScript adapter
            # already bounds arrays; this is a second defensive boundary.
            inputs = self.tokenizer(
                prompt, return_tensors="pt", truncation=True, max_length=7000
            )
            max_tokens = min(int(request.get("max_tokens", 96)), 96)
            with torch.no_grad():
                output = self.model.generate(
                    **inputs,
                    do_sample=False,
                    max_new_tokens=max_tokens,
                    pad_token_id=self.tokenizer.pad_token_id,
                )
            prompt_tokens = inputs["input_ids"].shape[1]
            generated = output[0][prompt_tokens:]
            content = self.tokenizer.decode(generated, skip_special_tokens=True).strip()
            self._send(
                200,
                {
                    "id": "local-open-model",
                    "object": "chat.completion",
                    "created": 0,
                    "model": self.model_id,
                    "choices": [
                        {
                            "index": 0,
                            "message": {"role": "assistant", "content": content},
                            "finish_reason": "stop",
                        }
                    ],
                },
            )
        except Exception as error:
            self._send(400, {"error": {"message": str(error)}})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--model",
        default=os.environ.get(
            "BBGM_OPEN_MODEL_ID", "HuggingFaceTB/SmolLM2-135M-Instruct"
        ),
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    print(f"local-model: loading {args.model}", flush=True)
    Handler.tokenizer, Handler.model = load_model(args.model)
    Handler.model_id = args.model
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"local-model: listening on http://{args.host}:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
