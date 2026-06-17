#!/usr/bin/env python3
"""Fetch 588000/159915 ETF option snapshots and write a static JSON bundle.

The website is hosted on GitHub Pages, so this script is designed to run from
GitHub Actions on a schedule. It uses AKShare as an aggregator for public SSE/SZSE
financial-option pages and writes data/options-market.json for the frontend.
"""
from __future__ import annotations

import argparse
import json
import math
import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

SYMBOLS = {
    "588000": {
        "name": "科创50ETF",
        "option_name": "华夏科创50ETF期权",
        "market": "SSE",
        "keywords": ["科创50 ETF 期权", "588000 期权", "半导体 政策 科创50", "AI 算力 ETF 资金流"],
    },
    "159915": {
        "name": "创业板ETF",
        "option_name": "易方达创业板ETF期权",
        "market": "SZSE",
        "keywords": ["创业板 ETF 期权", "159915 期权", "新能源 创业板 波动率", "医药 成长股 ETF 资金流"],
    },
}


def finite(value: Any, default: float | None = None) -> float | None:
    try:
        if value is None:
            return default
        number = float(value)
        if math.isnan(number) or math.isinf(number):
            return default
        return number
    except Exception:
        return default


def compact_int(value: Any, default: int = 0) -> int:
    number = finite(value, None)
    if number is None:
        return default
    return int(round(number))


def next_months(count: int = 6, today: date | None = None) -> list[str]:
    today = today or date.today()
    months: list[str] = []
    year, month = today.year, today.month
    for offset in range(count):
        m = month + offset
        y = year + (m - 1) // 12
        mm = (m - 1) % 12 + 1
        months.append(f"{str(y)[2:]}{mm:02d}")
    return months


def fourth_wednesday(year: int, month: int) -> date:
    first = date(year, month, 1)
    days_until_wed = (2 - first.weekday()) % 7
    return first + timedelta(days=days_until_wed + 21)


def expiry_from_code(code: str, end_month: str) -> str:
    match = re.search(r"([CP])(\d{4})", code)
    yy_mm = match.group(2) if match else end_month
    year = 2000 + int(yy_mm[:2])
    month = int(yy_mm[2:])
    return fourth_wednesday(year, month).isoformat()


def option_type_from_row(code: str, row_type: Any = None) -> str:
    text = f"{code} {row_type or ''}"
    if "认沽" in text or " P" in text or "-P-" in text or re.search(r"P\d{4}", text):
        return "put"
    return "call"


def row_get(row: Any, *names: str, default: Any = None) -> Any:
    for name in names:
        if name in row and row[name] is not None:
            return row[name]
    return default


def normalize_option_row(row: dict[str, Any], symbol: str, end_month: str) -> dict[str, Any] | None:
    code = str(row_get(row, "合约交易代码", "合约编码", "合约简称", "instrument", default="")).strip()
    if not code:
        return None
    strike = finite(row_get(row, "行权价", "exercise_price", "strike"), None)
    if strike is None or strike <= 0:
        return None
    option_type = option_type_from_row(code, row_get(row, "类型", "type"))
    last = finite(row_get(row, "当前价", "lastprice", "最新价", "last"), 0.0) or 0.0
    prev = finite(row_get(row, "前结价", "pre_settle", "prevClose"), last) or last
    bid = finite(row_get(row, "bprice", "买价", "bid"), None)
    ask = finite(row_get(row, "sprice", "卖价", "ask"), None)
    if bid is None or ask is None or bid <= 0 or ask <= 0 or ask < bid:
        spread = max(0.001, last * 0.04)
        bid = max(0.0001, last - spread / 2)
        ask = max(bid + 0.0001, last + spread / 2)
    volume = compact_int(row_get(row, "volume", "成交量", "数量"), 0)
    oi = compact_int(row_get(row, "position", "持仓量", "openInterest", "数量"), volume)
    return {
        "code": code,
        "type": option_type,
        "expiry": expiry_from_code(code, end_month),
        "strike": round(strike, 4),
        "last": round(last, 6),
        "bid": round(bid, 6),
        "ask": round(ask, 6),
        "mid": round((bid + ask) / 2, 6),
        "prevClose": round(prev, 6),
        "changePct": finite(row_get(row, "涨跌幅", "updown"), 0.0),
        "volume": volume,
        "openInterest": oi,
    }


def fetch_spot(ak: Any, symbol: str) -> tuple[float | None, float | None]:
    try:
        df = ak.fund_etf_spot_em()
        row = df[df["代码"].astype(str) == symbol]
        if row.empty:
            return None, None
        item = row.iloc[0].to_dict()
        return finite(item.get("最新价"), None), finite(item.get("涨跌幅"), None)
    except Exception:
        return None, None


def fetch_history(ak: Any, symbol: str) -> list[dict[str, Any]]:
    try:
        df = ak.fund_etf_hist_em(symbol=symbol, period="daily", adjust="qfq")
        rows = []
        for item in df.tail(180).to_dict("records"):
            rows.append({
                "date": str(item.get("日期"))[:10],
                "open": finite(item.get("开盘"), 0),
                "high": finite(item.get("最高"), 0),
                "low": finite(item.get("最低"), 0),
                "close": finite(item.get("收盘"), 0),
            })
        return [row for row in rows if row["close"]]
    except Exception:
        return []


def fetch_options(ak: Any, symbol: str, option_name: str) -> tuple[list[dict[str, Any]], list[str]]:
    options: list[dict[str, Any]] = []
    errors: list[str] = []
    seen: set[tuple[str, str]] = set()
    for end_month in next_months(6):
        try:
            df = ak.option_finance_board(symbol=option_name, end_month=end_month)
            for raw in df.to_dict("records"):
                normalized = normalize_option_row(raw, symbol, end_month)
                if not normalized:
                    continue
                key = (normalized["code"], normalized["expiry"])
                if key not in seen:
                    seen.add(key)
                    options.append(normalized)
        except Exception as exc:
            errors.append(f"{symbol} {end_month}: {exc}")
    options.sort(key=lambda x: (x["expiry"], x["strike"], x["type"], x["code"]))
    return options, errors


def synthetic_news(symbol: str, keywords: list[str]) -> list[dict[str, Any]]:
    return [
        {
            "title": f"{keyword} 最新公开资讯检索",
            "url": "https://www.google.com/search?q=" + keyword.replace(" ", "+"),
            "sentiment": 0,
            "heat": 58 + index * 7,
        }
        for index, keyword in enumerate(keywords[:4])
    ]


def fetch_symbol(ak: Any, symbol: str, info: dict[str, Any]) -> dict[str, Any]:
    spot, change_pct = fetch_spot(ak, symbol)
    history = fetch_history(ak, symbol)
    options, errors = fetch_options(ak, symbol, info["option_name"])
    if spot is None and history:
        spot = history[-1]["close"]
    return {
        "symbol": symbol,
        "name": info["name"],
        "market": info["market"],
        "source": "AKShare public SSE/SZSE option pages + Eastmoney ETF quote/history adapters",
        "spot": spot,
        "changePct": change_pct or 0,
        "history": history,
        "options": options,
        "news": synthetic_news(symbol, info["keywords"]),
        "errors": errors,
    }


def fallback_bundle(reason: str) -> dict[str, Any]:
    return {
        "version": 1,
        "mode": "FALLBACK_EMPTY",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": "crawler unavailable; frontend will use built-in research sample",
        "error": reason,
        "symbols": {},
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="data/options-market.json")
    parser.add_argument("--allow-empty", action="store_true", help="Write a fallback bundle instead of failing when crawling breaks")
    args = parser.parse_args()

    try:
        import akshare as ak  # type: ignore
    except Exception as exc:
        if args.allow_empty:
            bundle = fallback_bundle(f"akshare import failed: {exc}")
            Path(args.output).parent.mkdir(parents=True, exist_ok=True)
            Path(args.output).write_text(json.dumps(bundle, ensure_ascii=False, indent=2), encoding="utf-8")
            return 0
        raise

    symbols: dict[str, Any] = {}
    crawl_errors: list[str] = []
    for symbol, info in SYMBOLS.items():
        try:
            record = fetch_symbol(ak, symbol, info)
            symbols[symbol] = record
            crawl_errors.extend(record.get("errors", []))
        except Exception as exc:
            crawl_errors.append(f"{symbol}: {exc}")

    usable = any(record.get("options") or record.get("history") or record.get("spot") for record in symbols.values())
    if not usable and not args.allow_empty:
        raise RuntimeError("No usable market data was fetched")

    bundle = {
        "version": 1,
        "mode": "CRAWLED" if usable else "FALLBACK_EMPTY",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": "AKShare option_finance_board / fund_etf_spot_em / fund_etf_hist_em",
        "symbols": symbols,
        "errors": crawl_errors[-20:],
    }
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(bundle, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote {output} with {len(symbols)} symbols; mode={bundle['mode']}; errors={len(crawl_errors)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
