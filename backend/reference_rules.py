"""The reference sources configured for Рядом; never accept arbitrary fetch URLs."""
from urllib.parse import urlsplit, urlunsplit

REFERENCE_DOMAINS = {
    'РЛС': ('rlsnet.ru', 'www.rlsnet.ru'),
    'Видаль': ('vidal.ru', 'www.vidal.ru'),
    'ГРЛС': ('grls.rosminzdrav.ru',),
    'Минздрав': ('cr.minzdrav.gov.ru',),
    'МКБ-10': ('icd.who.int',),
    'Cochrane': ('cochranelibrary.com', 'www.cochranelibrary.com'),
}


def source_url(value, source):
    try:
        parts = urlsplit(value)
        if (parts.scheme != 'https' or parts.hostname not in REFERENCE_DOMAINS.get(source, ())
                or parts.username or parts.password or parts.port not in (None, 443)
                or '\\' in value or any(ord(c) < 32 for c in value)):
            return None
        return urlunsplit(('https', parts.netloc, parts.path, parts.query, parts.fragment))
    except (TypeError, ValueError):
        return None
