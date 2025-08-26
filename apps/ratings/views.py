import uuid
from django.shortcuts import get_object_or_404
from rest_framework import generics, status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from .models import Rating
from .serializers import RatingSerializer, CreateRatingSerializer, UpdateRatingSerializer

@api_view(['POST'])
@permission_classes([AllowAny])
def create_rating(request):
    serializer = CreateRatingSerializer(data=request.data)
    if not serializer.is_valid():
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
    
    data = serializer.validated_data
    
    # Determine user identification
    user = None
    user_id_anonymous = 'anonymous'
    
    if hasattr(request, 'user') and request.user.is_authenticated:
        user = request.user
        user_id_anonymous = request.user.user_id
    
    # Check if rating already exists
    existing_rating = Rating.objects.filter(
        project_id=data['project_id'],
        image_id=data['image_id'],
        user_id_anonymous=user_id_anonymous
    ).first()
    
    if existing_rating:
        # Update existing rating
        existing_rating.value = data['value']
        existing_rating.save()
        serializer = RatingSerializer(existing_rating)
        return Response(serializer.data)
    
    # Create new rating
    rating = Rating.objects.create(
        rating_id=str(uuid.uuid4()),
        project_id=data['project_id'],
        image_id=data['image_id'],
        value=data['value'],
        user=user,
        user_id_anonymous=user_id_anonymous
    )
    
    serializer = RatingSerializer(rating)
    return Response(serializer.data, status=status.HTTP_201_CREATED)

@api_view(['GET'])
@permission_classes([AllowAny])
def get_ratings(request, project_id):
    ratings = Rating.objects.filter(project_id=project_id)
    serializer = RatingSerializer(ratings, many=True)
    
    return Response({
        'ratings': serializer.data,
        'total': ratings.count()
    })

@api_view(['PUT'])
@permission_classes([AllowAny])
def update_rating(request, rating_id):
    rating = get_object_or_404(Rating, rating_id=rating_id)
    
    serializer = UpdateRatingSerializer(data=request.data)
    if not serializer.is_valid():
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)
    
    # Check if user can update this rating
    if rating.user_id_anonymous != 'anonymous':
        if not hasattr(request, 'user') or not request.user.is_authenticated:
            return Response(
                {'error': 'Authentication required'}, 
                status=status.HTTP_401_UNAUTHORIZED
            )
        
        if request.user.user_id != rating.user_id_anonymous:
            return Response(
                {'error': 'Permission denied'}, 
                status=status.HTTP_403_FORBIDDEN
            )
    
    rating.value = serializer.validated_data['value']
    rating.save()
    
    return Response({'message': 'Rating updated successfully'})

@api_view(['DELETE'])
@permission_classes([IsAuthenticated])
def delete_rating(request, rating_id):
    rating = get_object_or_404(Rating, rating_id=rating_id)
    
    # Check if user can delete this rating
    if rating.user != request.user:
        return Response(
            {'error': 'Permission denied'}, 
            status=status.HTTP_403_FORBIDDEN
        )
    
    rating.delete()
    return Response({'message': 'Rating deleted successfully'})