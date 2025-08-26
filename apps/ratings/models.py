from django.db import models
from django.contrib.auth import get_user_model
import uuid

User = get_user_model()

class Rating(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    rating_id = models.CharField(max_length=255, unique=True)
    project_id = models.CharField(max_length=255)
    user = models.ForeignKey(User, on_delete=models.CASCADE, null=True, blank=True)
    user_id_anonymous = models.CharField(max_length=255, default='anonymous')
    image_id = models.CharField(max_length=255)
    value = models.IntegerField()
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'ratings'
        unique_together = ['project_id', 'image_id', 'user_id_anonymous']

    def __str__(self):
        return f"Rating {self.value} for {self.image_id} by {self.user_id_anonymous}"

    @property
    def effective_user_id(self):
        return self.user.user_id if self.user else self.user_id_anonymous