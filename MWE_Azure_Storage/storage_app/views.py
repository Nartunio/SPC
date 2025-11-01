from rest_framework.decorators import api_view
from rest_framework.response import Response
from azure.storage.blob import BlobServiceClient, BlobClient


@api_view(["POST"])
def upload_file(request):
    account_name = request.data.get("account_name")
    sas_token = request.data.get("sas_token")
    container_name = request.data.get("container_name")

    if not all([account_name, sas_token, container_name]):
        return Response({"error": "No required data."}, status=400)

    uploaded_file = request.FILES.get("file")
    if not uploaded_file:
        return Response({"error": "No file found"}, status=status.HTTP_400_BAD_REQUEST)

    try:
        sas_url = f"https://{account_name}.blob.core.windows.net/?{sas_token}"
        blob_service = BlobServiceClient(account_url=sas_url)
        container_client = blob_service.get_container_client(container_name)

        blob_client = container_client.get_blob_client(uploaded_file.name)
        blob_client.upload_blob(uploaded_file.read(), overwrite=True)
        return Response({"message": f"File {uploaded_file.name} was uploaded."})

    except Exception as e:
        return Response({"error": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


@api_view(["GET"])
def download_file(request, filename):
    account_name = request.data.get("account_name")
    sas_token = request.data.get("sas_token")
    container_name = request.data.get("container_name")

    if not all([account_name, sas_token, container_name]):
        return Response({"error": "No required data."}, status=400)

    try:
        sas_url = f"https://{account_name}.blob.core.windows.net/?{sas_token}"
        blob_service = BlobServiceClient(account_url=sas_url)
        container_client = blob_service.get_container_client(container_name)

        blob_client = container_client.get_blob_client(filename)
        data = blob_client.download_blob().readall()
        response = Response(data, content_type="application/octet-stream")
        response["Content-Disposition"] = f"attachment; filename={filename}"
        return response

    except Exception as e:
        return Response({"error": str(e)}, status=status.HTTP_404_NOT_FOUND)


@api_view(["GET"])
def list_files(request):
    account_name = request.data.get("account_name")
    sas_token = request.data.get("sas_token")
    container_name = request.data.get("container_name")

    if not all([account_name, sas_token, container_name]):
        return Response({"error": "No required data."}, status=400)

    try:
        sas_url = f"https://{account_name}.blob.core.windows.net/?{sas_token}"
        blob_service = BlobServiceClient(account_url=sas_url)
        container_client = blob_service.get_container_client(container_name)

        blobs = [blob.name for blob in container_client.list_blobs()]
        return Response(blobs)

    except Exception as e:
        return Response({"error": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)