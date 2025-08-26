from rest_framework import generics, status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated, AllowAny
from rest_framework.response import Response
from django.shortcuts import get_object_or_404
from .models import User
from .serializers import UserSerializer, UserUpdateSerializer, PublicUserSerializer

class CurrentUserView(generics.RetrieveAPIView):
    serializer_class = UserSerializer
    permission_classes = [IsAuthenticated]

    def get_object(self):
        return self.request.user

class UserDetailView(generics.RetrieveAPIView):
    serializer_class = UserSerializer
    permission_classes = [IsAuthenticated]
    lookup_field = 'user_id'
    queryset = User.objects.all()

class UserUpdateView(generics.UpdateAPIView):
    serializer_class = UserUpdateSerializer
    permission_classes = [IsAuthenticated]

    def get_object(self):
        return self.request.user

class UserDeleteView(generics.DestroyAPIView):
    permission_classes = [IsAuthenticated]

    def get_object(self):
        return self.request.user

    def destroy(self, request, *args, **kwargs):
        instance = self.get_object()
        self.perform_destroy(instance)
        return Response({'message': 'User deleted successfully'}, status=status.HTTP_200_OK)

@api_view(['GET'])
@permission_classes([AllowAny])
def get_user_by_username(request, username):
    user = get_object_or_404(User, username=username)
    serializer = PublicUserSerializer(user)
    return Response({'user': serializer.data})

@api_view(['PUT'])
@permission_classes([IsAuthenticated])
def update_dropbox_token(request):
    user = request.user
    dropbox_data = request.data.get('dropbox', {})
    
    if not dropbox_data.get('access_token'):
        return Response(
            {'error': 'Dropbox access token is required'}, 
            status=status.HTTP_400_BAD_REQUEST
        )
    
    user.dropbox_access_token = dropbox_data.get('access_token')
    user.dropbox_refresh_token = dropbox_data.get('refresh_token')
    user.save()
    
    return Response({'message': 'Dropbox token updated successfully'})