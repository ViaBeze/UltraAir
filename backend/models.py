from datetime import date, datetime
from typing import Annotated, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

Short = Annotated[str, Field(max_length=200)]
Text = Annotated[str, Field(max_length=10000)]
Password = Annotated[str, Field(min_length=12, max_length=128)]
Login = Annotated[str, Field(min_length=3, max_length=80, pattern=r'^[a-zA-Z0-9@._+\-]+$')]
Time = Annotated[str, Field(pattern=r'^([01]\d|2[0-3]):[0-5]\d$')]


class Model(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)


class Credentials(Model):
    login: Login
    password: Annotated[str, Field(min_length=1, max_length=128)]


class Registration(Model):
    login: Login
    name: Annotated[str, Field(min_length=2, max_length=100)]
    password: Password
    consent: Literal[True]


class Activation(Model):
    token: Annotated[str, Field(min_length=20, max_length=200)]
    password: Password
    consent: Literal[True]


class Recovery(Model):
    login: Login
    code: Annotated[str, Field(min_length=10, max_length=200)]
    password: Password


class PasswordChange(Model):
    current: Annotated[str, Field(min_length=1, max_length=128)]
    password: Password


class PatientCreate(Model):
    name: Annotated[str, Field(min_length=2, max_length=100)]
    birth: date
    phone: Annotated[str, Field(max_length=40)] = ''
    email: Annotated[str, Field(max_length=150)] = ''
    department: Short = 'Амбулаторное наблюдение'
    note: Text = ''
    consent: Literal[True]

    @field_validator('birth')
    @classmethod
    def birth_range(cls, value):
        if value > date.today() or value < date(1900, 1, 1):
            raise ValueError('Проверьте дату рождения')
        return value


class ProfileUpdate(Model):
    version: int = Field(ge=1)
    name: Annotated[str, Field(min_length=2, max_length=100)]
    birth: date
    phone: Annotated[str, Field(max_length=40)] = ''
    email: Annotated[str, Field(max_length=150)] = ''
    department: Short = 'Амбулаторное наблюдение'

    @field_validator('birth')
    @classmethod
    def birth_range(cls, value):
        if value > date.today() or value < date(1900, 1, 1):
            raise ValueError('Проверьте дату рождения')
        return value


class Clinical(Model):
    version: int = Field(ge=1)
    diagnosis: Text = ''
    treatment: Text = ''
    allergy: Text = ''
    medications: Annotated[list[Short], Field(max_length=50)] = []
    conditions: Text = ''
    note: Text = ''
    transfer: Text = ''


class Diary(Model):
    date: date
    score: int = Field(ge=1, le=10)
    sleep: float = Field(ge=0, le=24)
    energy: int = Field(ge=0, le=10)
    tags: Annotated[list[Short], Field(max_length=12)] = []
    comment: Text = ''
    mediaId: str | None = None

    @field_validator('date')
    @classmethod
    def not_future(cls, value):
        # Allow the next UTC date for clients ahead of the server's timezone.
        from datetime import timedelta
        if value > date.today() + timedelta(days=1):
            raise ValueError('Нельзя добавить запись в будущем')
        return value


class Prescription(Model):
    name: Annotated[str, Field(min_length=1, max_length=200)]
    dose: Annotated[str, Field(min_length=1, max_length=200)]
    instructions: Annotated[str, Field(max_length=2000)] = ''
    times: Annotated[list[Time], Field(min_length=1, max_length=8)]
    start: date
    end: date | None = None

    @model_validator(mode='after')
    def dates(self):
        if self.end and self.end < self.start:
            raise ValueError('Окончание раньше начала')
        if len(set(self.times)) != len(self.times):
            raise ValueError('Время приёма повторяется')
        return self


class VisitCreate(Model):
    patientId: str
    scheduled: datetime
    title: Short = 'Приём'

    @field_validator('scheduled')
    @classmethod
    def aware(cls, value):
        if not value.tzinfo:
            raise ValueError('Укажите часовой пояс')
        return value


class VisitEdit(Model):
    version: int = Field(ge=1)
    title: Short = 'Приём'
    notes: Text = ''
    observation: Text = ''
    diagnosis: Text = ''
    plan: Text = ''
    prescriptions: Annotated[list[Prescription], Field(max_length=30)] = []
    confirm: bool = False
    cancel: bool = False


class MessageCreate(Model):
    id: Annotated[str, Field(min_length=16, max_length=80)]
    patientId: str
    text: Annotated[str, Field(max_length=5000)] = ''
    sosId: str | None = None
    mediaId: str | None = None

    @model_validator(mode='after')
    def content(self):
        if not self.text and not self.mediaId:
            raise ValueError('Пустое сообщение')
        return self


class ReadMessages(Model):
    ids: Annotated[list[str], Field(max_length=500)]


class SosEdit(Model):
    severity: int = Field(ge=0, le=10)
    danger: Literal['', 'yes', 'unsure', 'no'] = ''
    detail: Text = ''
    medication: Annotated[str, Field(max_length=2000)] = ''


class Mark(Model):
    date: date
    time: Time
    status: Literal['taken', 'skipped', 'later']
    note: Annotated[str, Field(max_length=1000)] = ''


class Settings(Model):
    source: Literal['РЛС', 'Видаль', 'ГРЛС', 'Яндекс', 'Google'] = 'РЛС'
    diary: Time = '19:00'
    enabled: bool = True
    timezone: Annotated[str, Field(max_length=80)] = 'Europe/Moscow'

    @field_validator('timezone')
    @classmethod
    def valid_timezone(cls, value):
        try:
            ZoneInfo(value)
        except ZoneInfoNotFoundError:
            raise ValueError('Неизвестный часовой пояс')
        return value
