"""Nearby pharmacies from OSM, optional inventory feed, no invented stock/prices."""
import asyncio
import hashlib
import json
import math
import os
import time
from datetime import datetime, timezone, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Annotated
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import Field, ValidationError, field_validator

from .auth import current_user, limit
from .db import dump, get_db, now
from .models import Model

router = APIRouter(prefix='/api/pharmacies')
HEADERS = {'User-Agent': 'RyadomPharmacies/1.0 (+https://ryadomhelp.online)'}
geocode_lock = asyncio.Lock()
last_geocode = 0.0


class LocationQuery(Model):
    query: Annotated[str, Field(min_length=2, max_length=120)]


class Nearby(Model):
    lat: float = Field(ge=-85, le=85, allow_inf_nan=False)
    lon: float = Field(ge=-180, le=180, allow_inf_nan=False)
    radius: int = Field(default=3000, ge=500, le=10000)
    query: Annotated[str, Field(min_length=2, max_length=120)] = 'Авиандр'


class Offer(Model):
    id: Annotated[str, Field(min_length=1, max_length=100)]
    name: Annotated[str, Field(min_length=1, max_length=200)]
    address: Annotated[str, Field(min_length=1, max_length=400)]
    lat: float = Field(ge=-85, le=85, allow_inf_nan=False)
    lon: float = Field(ge=-180, le=180, allow_inf_nan=False)
    medicine: Annotated[str, Field(min_length=1, max_length=200)]
    form: Annotated[str, Field(min_length=1, max_length=200)]
    packageSize: int | None = Field(default=None, ge=1, le=10000)
    price: Decimal = Field(gt=0, le=10000000, max_digits=10, decimal_places=2)
    available: bool
    url: Annotated[str, Field(max_length=2000)]
    updatedAt: datetime
    source: Annotated[str, Field(min_length=1, max_length=200)]

    @field_validator('url')
    @classmethod
    def safe_url(cls, value):
        parts = urlsplit(value)
        if parts.scheme != 'https' or not parts.hostname or parts.username or parts.password or '\\' in value:
            raise ValueError('Expected a public HTTPS offer URL')
        return value

    @field_validator('updatedAt')
    @classmethod
    def aware(cls, value):
        if not value.tzinfo or value > datetime.now(timezone.utc) + timedelta(minutes=5):
            raise ValueError('Expected a timestamp with timezone, not in the future')
        return value


class Feed(Model):
    offers: Annotated[list[Offer], Field(max_length=3000)]


def distance(lat, lon, other_lat, other_lon):
    a, b = math.radians(lat), math.radians(other_lat)
    h = math.sin((b - a) / 2)**2 + math.cos(a) * math.cos(b) * math.sin(math.radians(other_lon - lon) / 2)**2
    return round(6371000 * 2 * math.asin(min(1, math.sqrt(h))))


def inventory(data):
    path = os.environ.get('RYADOM_PHARMACY_FEED')
    if not path:
        return [], False, ''
    try:
        with Path(path).open('rb') as file:
            raw = file.read(2_000_001)
        if len(raw) > 2_000_000:
            raise ValueError('Feed too large')
        feed = Feed.model_validate_json(raw)
    except (OSError, ValueError, ValidationError):
        return [], False, 'Данные о наличии и ценах временно недоступны.'
    items = []
    for offer in feed.offers:
        meters = distance(data.lat, data.lon, offer.lat, offer.lon)
        if data.query.casefold() not in offer.medicine.casefold() or meters > data.radius:
            continue
        fresh = datetime.now(timezone.utc) - offer.updatedAt <= timedelta(hours=24)
        items.append({**offer.model_dump(mode='json', exclude={'available'}), 'id': 'offer:' + offer.id,
                      'price': float(offer.price) if fresh and offer.available else None,
                      'availability': ('available' if offer.available else 'unavailable') if fresh else 'unknown',
                      'distance': meters, 'stale': not fresh})
    return items, True, ''


def cache_get(db, key):
    row = db.execute('SELECT data,expires FROM medicine_search_cache WHERE key=?', (key,)).fetchone()
    return json.loads(row['data']) if row and row['expires'] > time.time() else None


def cache_put(db, key, value, lifetime):
    db.execute('DELETE FROM medicine_search_cache WHERE expires<?', (time.time(),))
    db.execute('INSERT OR REPLACE INTO medicine_search_cache VALUES(?,?,?)', (key, dump(value), time.time() + lifetime))


async def map_elements(data):
    endpoints = list(dict.fromkeys(filter(None, [
        os.environ.get('RYADOM_OVERPASS_URL', 'https://overpass-api.de/api/interpreter'),
        os.environ.get('RYADOM_OVERPASS_FALLBACK_URL'),
    ])))
    budget = 11 if len(endpoints) > 1 else 22
    query = f'[out:json][timeout:{budget - 3}];nwr["amenity"="pharmacy"](around:{data.radius},{data.lat},{data.lon});out center 150;'
    for index, endpoint in enumerate(endpoints):
        try:
            async with asyncio.timeout(budget):
                async with httpx.AsyncClient(timeout=budget, headers=HEADERS) as client:
                    response = await client.post(endpoint, data={'data': query})
                    response.raise_for_status()
                    value = response.json()
                    # Overpass can return HTTP 200 with partial data after a timeout.
                    if value.get('remark') or not isinstance(value.get('elements'), list):
                        raise ValueError('Incomplete map response')
                    return value['elements']
        except (httpx.HTTPError, TimeoutError, ValueError, TypeError, AttributeError):
            if index == len(endpoints) - 1:
                raise


@router.post('/location')
async def location(data: LocationQuery, user=Depends(current_user), db=Depends(get_db, scope='function')):
    global last_geocode
    endpoint = os.environ.get('RYADOM_GEOCODER_URL')
    if not endpoint:
        raise HTTPException(503, 'Поиск адресов пока не подключён. Выберите город или переместите карту.')
    key = 'geocode:' + hashlib.sha256(data.query.casefold().encode()).hexdigest()
    if (cached := cache_get(db, key)) is not None:
        return cached
    limit('geocode:' + user['id'], 30, 3600)
    try:
        # Nominatim allows at most one request/second for an application. There
        # is no autocomplete; results are cached for a day.
        async with geocode_lock:
            await asyncio.sleep(max(0, 1 - (time.monotonic() - last_geocode)))
            async with httpx.AsyncClient(timeout=12, headers=HEADERS) as client:
                last_geocode = time.monotonic()
                result = await client.get(endpoint, params={
                    'q': data.query, 'format': 'jsonv2', 'limit': 5, 'accept-language': 'ru',
                })
                result.raise_for_status()
                items = [{'name': row['display_name'], 'lat': float(row['lat']), 'lon': float(row['lon'])}
                         for row in result.json() if -85 <= float(row['lat']) <= 85]
    except (httpx.HTTPError, ValueError, KeyError, TypeError, AttributeError):
        raise HTTPException(502, 'Не удалось найти адрес. Переместите карту или повторите поиск.') from None
    value = {'items': items}
    cache_put(db, key, value, 86400)
    return value


@router.get('/config')
def config(user=Depends(current_user)):
    return {'addressSearch': bool(os.environ.get('RYADOM_GEOCODER_URL'))}


@router.post('/search')
async def nearby(data: Nearby, user=Depends(current_user), db=Depends(get_db, scope='function')):
    offers, connected, warning = inventory(data)
    key = 'pharmacies:' + hashlib.sha256(dump([round(data.lat, 4), round(data.lon, 4), data.radius]).encode()).hexdigest()
    cached = cache_get(db, key)
    if cached is None:
        limit('pharmacies:' + user['id'], 60, 3600)
        try:
            elements = await map_elements(data)
            items = []
            for row in elements:
                tags, center = row.get('tags', {}), row.get('center', row)
                lat, lon = center.get('lat'), center.get('lon')
                if lat is None or lon is None:
                    continue
                address = ', '.join(filter(None, [tags.get('addr:city'), tags.get('addr:street'), tags.get('addr:housenumber')]))
                items.append({'id': f"osm:{row['type']}:{row['id']}", 'name': tags.get('name', 'Аптека'),
                              'address': address or 'Адрес не указан в OpenStreetMap', 'lat': lat, 'lon': lon,
                              'distance': distance(data.lat, data.lon, lat, lon), 'availability': 'unknown',
                              'price': None, 'source': 'OpenStreetMap', 'updatedAt': None,
                              'url': f"https://www.openstreetmap.org/{row['type']}/{row['id']}"})
            cached = {'items': items, 'checkedAt': now()}
            cache_put(db, key, cached, 900)
        except (httpx.HTTPError, TimeoutError, ValueError, KeyError, TypeError, AttributeError):
            warning = 'Карта аптек временно не отвечает. Попробуйте поиск ещё раз.' + (' ' + warning if warning else '')
            cached = {'items': [], 'checkedAt': now()}
    items = offers + cached['items']
    items.sort(key=lambda item: (item['availability'] != 'available', item['distance']))
    return {'items': items, 'inventoryConnected': connected, 'checkedAt': cached['checkedAt'], 'warning': warning}
