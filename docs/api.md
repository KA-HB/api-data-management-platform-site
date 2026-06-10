# API Reference

## Authentication

Every API endpoint requires:

```http
Authorization: Bearer <API_KEY>
```

API keys use this format:

```text
DATA_PLATFORM_API_KEY
```

Only the SHA-256 hash is stored.

## List Datasets

```http
GET /functions/v1/api/datasets?page=1&page_size=50&search=time
```

## Get Dataset Metadata

```http
GET /functions/v1/api/datasets/{dataset_id}
```

Returns dataset metadata plus an inferred JSON schema sample.

## List Records

```http
GET /functions/v1/api/datasets/{dataset_id}/records?page=1&page_size=50&search=smith
```

Response:

```json
{
  "data": [
    {
      "id": "record-id",
      "dataset_id": "dataset-id",
      "json_data": {},
      "created_at": "2026-06-10T00:00:00Z"
    }
  ],
  "meta": {
    "page": 1,
    "page_size": 50
  }
}
```
